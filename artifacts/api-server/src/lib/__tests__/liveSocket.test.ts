import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import WebSocket from "ws";
import { attachLiveSocketServer } from "../liveSocket";
import { liveStreamRegistry } from "../liveStream";

const TEST_CODE = "TESTCODE";

function seedSession() {
  const session = {
    code: TEST_CODE,
    meta: { opponent: "Rivals", teamName: "Home" },
    createdAt: Date.now(),
    broadcaster: null,
    viewers: new Map(),
    scoreboard: { teamScore: 0, opponentScore: 0 },
    recentEvents: [],
  };
  // The registry only exposes DB-backed create/resume paths; for a
  // deterministic, DB-free regression test of pure message-routing logic we
  // seed the in-memory session map directly instead.
  (liveStreamRegistry as unknown as { sessions: Map<string, unknown> }).sessions.set(TEST_CODE, session);
  return session;
}

// Messages can arrive before a test gets around to awaiting them (e.g. a
// "new-viewer" notice fired the instant a second client joins), and a plain
// ws "message" listener attached later would miss anything already emitted.
// So every socket gets a backlog buffer attached immediately on connect, and
// waitForMessage drains that backlog before falling back to a live listener.
const backlogs = new WeakMap<WebSocket, any[]>();

function trackMessages(ws: WebSocket) {
  const backlog: any[] = [];
  backlogs.set(ws, backlog);
  ws.on("message", (raw: WebSocket.RawData) => {
    backlog.push(JSON.parse(raw.toString()));
  });
}

function waitForMessage(ws: WebSocket, predicate?: (msg: any) => boolean, timeoutMs = 2000): Promise<any> {
  const backlog = backlogs.get(ws) ?? [];
  const bufferedIndex = backlog.findIndex((msg) => !predicate || predicate(msg));
  if (bufferedIndex !== -1) {
    const [msg] = backlog.splice(bufferedIndex, 1);
    return Promise.resolve(msg);
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error("Timed out waiting for message"));
    }, timeoutMs);
    function onMessage(raw: WebSocket.RawData) {
      const msg = JSON.parse(raw.toString());
      if (!predicate || predicate(msg)) {
        clearTimeout(timer);
        ws.off("message", onMessage);
        // Remove it from the backlog too, since trackMessages' listener
        // will also have pushed it there.
        const backlogArr = backlogs.get(ws);
        if (backlogArr) {
          const idx = backlogArr.indexOf(msg);
          if (idx !== -1) backlogArr.splice(idx, 1);
        }
        resolve(msg);
      }
    }
    ws.on("message", onMessage);
  });
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => {
      trackMessages(ws);
      resolve();
    });
    ws.once("error", reject);
  });
}

describe("liveSocket signaling relay", () => {
  let server: Server;
  let wsUrl: string;

  beforeAll(async () => {
    server = createServer();
    attachLiveSocketServer(server);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    wsUrl = `ws://127.0.0.1:${port}/api/live/ws`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    seedSession();
  });

  async function connectBroadcaster() {
    const ws = new WebSocket(wsUrl);
    await waitForOpen(ws);
    ws.send(JSON.stringify({ type: "join-broadcaster", code: TEST_CODE }));
    return ws;
  }

  async function connectViewer(): Promise<{ ws: WebSocket; viewerId: string }> {
    const ws = new WebSocket(wsUrl);
    await waitForOpen(ws);
    ws.send(JSON.stringify({ type: "join-viewer", code: TEST_CODE }));
    const joined = await waitForMessage(ws, (m) => m.type === "joined");
    return { ws, viewerId: joined.viewerId };
  }

  it("relays an offer from the broadcaster to the targeted viewer only", async () => {
    const broadcaster = await connectBroadcaster();
    const { ws: viewer, viewerId } = await connectViewer();
    const { ws: otherViewer } = await connectViewer();

    await waitForMessage(broadcaster, (m) => m.type === "new-viewer" && m.viewerId === viewerId);

    broadcaster.send(
      JSON.stringify({ type: "offer", code: TEST_CODE, targetId: viewerId, sdp: { fake: "sdp" } }),
    );

    const offer = await waitForMessage(viewer, (m) => m.type === "offer");
    expect(offer.sdp).toEqual({ fake: "sdp" });
    expect(offer.viewerId).toBe(viewerId);
    expect(offer.renegotiate).toBe(false);

    await expect(waitForMessage(otherViewer, (m) => m.type === "offer", 300)).rejects.toThrow();

    broadcaster.close();
    viewer.close();
    otherViewer.close();
  });

  it("preserves the renegotiate flag on an ICE-restart offer", async () => {
    const broadcaster = await connectBroadcaster();
    const { ws: viewer, viewerId } = await connectViewer();
    await waitForMessage(broadcaster, (m) => m.type === "new-viewer");

    broadcaster.send(
      JSON.stringify({
        type: "offer",
        code: TEST_CODE,
        targetId: viewerId,
        sdp: { fake: "sdp2" },
        renegotiate: true,
      }),
    );

    const offer = await waitForMessage(viewer, (m) => m.type === "offer");
    expect(offer.renegotiate).toBe(true);

    broadcaster.close();
    viewer.close();
  });

  it("relays an answer from a viewer back to the broadcaster", async () => {
    const broadcaster = await connectBroadcaster();
    const { ws: viewer, viewerId } = await connectViewer();
    await waitForMessage(broadcaster, (m) => m.type === "new-viewer");

    viewer.send(
      JSON.stringify({ type: "answer", code: TEST_CODE, targetId: viewerId, sdp: { fake: "answer-sdp" } }),
    );

    const answer = await waitForMessage(broadcaster, (m) => m.type === "answer");
    expect(answer.sdp).toEqual({ fake: "answer-sdp" });
    expect(answer.viewerId).toBe(viewerId);

    broadcaster.close();
    viewer.close();
  });

  it("relays ice-candidates in both directions", async () => {
    const broadcaster = await connectBroadcaster();
    const { ws: viewer, viewerId } = await connectViewer();
    await waitForMessage(broadcaster, (m) => m.type === "new-viewer");

    viewer.send(
      JSON.stringify({
        type: "ice-candidate",
        code: TEST_CODE,
        targetId: "broadcaster",
        candidate: { c: "viewer-candidate" },
      }),
    );
    const toBroadcaster = await waitForMessage(broadcaster, (m) => m.type === "ice-candidate");
    expect(toBroadcaster.candidate).toEqual({ c: "viewer-candidate" });
    expect(toBroadcaster.viewerId).toBe(viewerId);

    broadcaster.send(
      JSON.stringify({
        type: "ice-candidate",
        code: TEST_CODE,
        targetId: viewerId,
        candidate: { c: "broadcaster-candidate" },
      }),
    );
    const toViewer = await waitForMessage(viewer, (m) => m.type === "ice-candidate");
    expect(toViewer.candidate).toEqual({ c: "broadcaster-candidate" });

    broadcaster.close();
    viewer.close();
  });

  it("relays a peer-connection-failed notice from the broadcaster to the targeted viewer", async () => {
    const broadcaster = await connectBroadcaster();
    const { ws: viewer, viewerId } = await connectViewer();
    const { ws: otherViewer } = await connectViewer();
    await waitForMessage(broadcaster, (m) => m.type === "new-viewer" && m.viewerId === viewerId);

    broadcaster.send(
      JSON.stringify({ type: "peer-connection-failed", code: TEST_CODE, targetId: viewerId }),
    );

    const failed = await waitForMessage(viewer, (m) => m.type === "peer-connection-failed");
    expect(failed.type).toBe("peer-connection-failed");

    await expect(
      waitForMessage(otherViewer, (m) => m.type === "peer-connection-failed", 300),
    ).rejects.toThrow();

    broadcaster.close();
    viewer.close();
    otherViewer.close();
  });

  it("ignores peer-connection-failed sent by a non-broadcaster role", async () => {
    const broadcaster = await connectBroadcaster();
    const { ws: viewer, viewerId } = await connectViewer();

    viewer.send(
      JSON.stringify({ type: "peer-connection-failed", code: TEST_CODE, targetId: viewerId }),
    );

    await expect(
      waitForMessage(viewer, (m) => m.type === "peer-connection-failed", 300),
    ).rejects.toThrow();

    broadcaster.close();
    viewer.close();
  });

  it("relays request-offer from a viewer to the broadcaster as new-viewer", async () => {
    const broadcaster = await connectBroadcaster();
    // Wait for broadcaster-joined ack before continuing so it is fully registered.
    await waitForMessage(broadcaster, (m) => m.type === "broadcaster-joined");

    const { ws: viewer, viewerId } = await connectViewer();
    // The broadcaster receives a new-viewer notice when the viewer joins; drain it.
    await waitForMessage(broadcaster, (m) => m.type === "new-viewer" && m.viewerId === viewerId);

    // Simulate the viewer's ICE negotiation timing out and requesting a fresh offer.
    viewer.send(JSON.stringify({ type: "request-offer", code: TEST_CODE }));

    // The server must relay a new-viewer message with the same viewerId so the
    // broadcaster creates a new RTCPeerConnection for that slot without duplicating
    // the viewer's entry in the session's viewer map.
    const relayed = await waitForMessage(broadcaster, (m) => m.type === "new-viewer");
    expect(relayed.viewerId).toBe(viewerId);

    broadcaster.close();
    viewer.close();
  });

  it("drops request-offer silently when no broadcaster is connected", async () => {
    // Viewer joins with no broadcaster present; request-offer must not crash the
    // server or send anything back to the viewer.
    const { ws: viewer } = await connectViewer();

    viewer.send(JSON.stringify({ type: "request-offer", code: TEST_CODE }));

    // No error or unexpected message should arrive on the viewer socket.
    await expect(
      waitForMessage(viewer, (m) => m.type === "error" || m.type === "new-viewer", 300),
    ).rejects.toThrow();

    viewer.close();
  });

  it("drops request-offer silently when sent by the broadcaster role", async () => {
    const broadcaster = await connectBroadcaster();
    await waitForMessage(broadcaster, (m) => m.type === "broadcaster-joined");

    // A malformed client sending request-offer from the broadcaster slot must
    // not corrupt session state or produce any relay message.
    broadcaster.send(JSON.stringify({ type: "request-offer", code: TEST_CODE }));

    await expect(
      waitForMessage(broadcaster, (m) => m.type === "new-viewer", 300),
    ).rejects.toThrow();

    broadcaster.close();
  });
});
