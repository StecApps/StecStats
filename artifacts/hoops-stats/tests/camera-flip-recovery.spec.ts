/**
 * camera-flip-recovery.spec.ts
 *
 * Confirms that a viewer watching a live WebRTC stream gracefully recovers
 * when the coach flips the camera mid-game.
 *
 * What happens on the broadcaster side during a camera flip
 * ---------------------------------------------------------
 * The cameraFacing state changes → the WebRTC useEffect (which lists
 * cameraFacing as a dep) re-runs: the cleanup calls closeAllWebRtcPeers()
 * (closes every RTCPeerConnection) and stopWebRtcStream(), then the new effect
 * body opens a fresh getUserMedia stream with the new facingMode.
 *
 * What the viewer sees
 * --------------------
 * The viewer's existing RTCPeerConnection transitions to "failed" (the remote
 * end closed abruptly).  Before the fix, the viewer's signaling WS remained
 * open but the component had no automatic recovery path — it stayed in the
 * "reconnecting" overlay until the 15-second "Tap to retry" threshold
 * appeared.  After the fix, "failed" on the PC immediately sends
 * request-offer over the still-open WS so the broadcaster can reply with a
 * fresh offer from the new camera, recovering video within ~1 s.
 *
 * Two scenarios are tested
 * ------------------------
 * A – Camera flip mid-game
 *     Viewer is live, broadcaster closes the PC (camera flip), viewer's PC
 *     goes to "failed", component sends request-offer automatically, server
 *     delivers a new offer, viewer returns to "live" state.
 *
 * B – No crash / black screen on camera flip (regression guard)
 *     Same flow, but the test asserts the video overlay stays visible and the
 *     error screen never appears.  Confirms no permanent black screen after
 *     the flip.
 *
 * What is mocked vs exercised
 * ---------------------------
 * Mocked  : HTTP health-gate, live session status, ICE server config, WS
 *           signaling server, RTCPeerConnection (browser layer)
 * Exercised: watch.tsx state machine, attachConnectionStateHandlers "failed"
 *            branch (request-offer send), WS message parsing, live-state UI
 */

import { test, expect } from "@playwright/test";

const CODE = "FLIP1";

// Minimal SDP offer recognised by the browser's SDP parser.
const OFFER_SDP = [
  "v=0",
  "o=- 9876543210 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE 0",
  "a=msid-semantic: WMS",
  "m=video 9 UDP/TLS/RTP/SAVPF 96",
  "c=IN IP4 0.0.0.0",
  "a=rtcp:9 IN IP4 0.0.0.0",
  "a=ice-ufrag:flipufrag01",
  "a=ice-pwd:flippassword01flippassword01flip",
  "a=ice-options:trickle",
  "a=fingerprint:sha-256 " +
    "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:" +
    "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89",
  "a=setup:actpass",
  "a=mid:0",
  "a=sendonly",
  "a=rtcp-mux",
  "a=rtpmap:96 VP8/90000",
].join("\r\n") + "\r\n";

/**
 * FakePeerConnection injected before page load.
 *
 * Behaviour:
 *  • Every instance auto-connects after setRemoteDescription (simulates normal
 *    WebRTC success).
 *  • window.__hoopsFailCurrentPc() fires connectionState="failed" on the
 *    currently active instance — simulates the broadcaster closing the PC
 *    when it flips cameras.
 *  • A per-instance index lets the test distinguish the initial offer from
 *    the post-flip offer.
 */
const FAKE_PC_SCRIPT = `
(function () {
  var __currentPc = null;
  var __fpcCount  = 0;

  // Dev-only hook: simulate the broadcaster closing this viewer's peer
  // connection (happens when the coach flips cameras and closeAllWebRtcPeers
  // is called on the mobile side).
  window.__hoopsFailCurrentPc = function () {
    var pc = __currentPc;
    if (!pc) return;
    pc._closed = true;
    pc.connectionState    = "failed";
    pc.iceConnectionState = "failed";
    if (pc.onconnectionstatechange)  pc.onconnectionstatechange();
    if (pc.oniceconnectionstatechange) pc.oniceconnectionstatechange();
  };

  class FakePeerConnection {
    constructor() {
      this.connectionState    = "new";
      this.iceConnectionState = "new";
      this.ontrack = null;
      this.onicecandidate = null;
      this.onconnectionstatechange = null;
      this.oniceconnectionstatechange = null;
      this._closed = false;
      this._index  = __fpcCount++;
      __currentPc  = this;
    }

    async setRemoteDescription(_desc) {
      if (this._closed) return;
      var self = this;
      setTimeout(function () {
        if (self._closed) return;
        // Fire ontrack so the component sets remoteStreamRef and calls
        // attachStream() / setState("live").
        if (self.ontrack) {
          var stream = new MediaStream();
          self.ontrack({ track: { kind: "video" }, streams: [stream] });
        }
        self.connectionState    = "connected";
        self.iceConnectionState = "connected";
        if (self.onconnectionstatechange)  self.onconnectionstatechange();
        if (self.oniceconnectionstatechange) self.oniceconnectionstatechange();
      }, 150);
    }

    async createAnswer() {
      return {
        type: "answer",
        sdp: [
          "v=0",
          "o=- 0 0 IN IP4 127.0.0.1",
          "s=-",
          "t=0 0",
          "a=group:BUNDLE 0",
          "m=video 9 UDP/TLS/RTP/SAVPF 96",
          "c=IN IP4 0.0.0.0",
          "a=mid:0",
          "a=recvonly",
          "a=rtcp-mux",
          "a=rtpmap:96 VP8/90000",
        ].join("\\r\\n") + "\\r\\n",
      };
    }

    async setLocalDescription(_desc) {}
    addIceCandidate() { return Promise.resolve(); }

    close() {
      this._closed = true;
      this.connectionState = "closed";
      if (__currentPc === this) __currentPc = null;
    }
  }

  window.RTCPeerConnection = FakePeerConnection;
})();
`;

// ---------------------------------------------------------------------------
// Shared HTTP route helpers
// ---------------------------------------------------------------------------

async function setupHttpMocks(page: import("@playwright/test").Page) {
  // Health-gate — lets the app past the ServerReadinessGate check.
  await page.route(
    (url) => url.pathname === "/api",
    (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );

  // Active live session.
  await page.route(
    (url) => url.pathname === `/api/live/${CODE}/status`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          active: true,
          opponent: "Visitors",
          teamName: "Home",
          viewerCount: 3,
          teamScore: 24,
          opponentScore: 18,
        }),
      }),
  );

  // STUN-only ICE config — no real network needed.
  await page.route(
    (url) => url.pathname === "/api/live/ice-servers",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
          turnAvailable: true,
        }),
      }),
  );
}

// ---------------------------------------------------------------------------
// Test A — camera flip triggers automatic request-offer and recovery to live
// ---------------------------------------------------------------------------

test.describe("Watch page – camera flip mid-game recovery", () => {
  test(
    "A – viewer sends request-offer automatically when PC fails after camera flip, recovers to live",
    async ({ page }) => {
      await page.addInitScript({ content: FAKE_PC_SCRIPT });
      await setupHttpMocks(page);

      // Collect messages sent from the viewer to the WS server so we can
      // assert request-offer is sent after the PC fails.
      const viewerMessages: Array<{ type: string }> = [];
      let serverWs: import("@playwright/test").WebSocketRoute | null = null;

      await page.routeWebSocket(
        (url) => url.pathname === "/api/live/ws",
        (ws) => {
          serverWs = ws;

          ws.onMessage((raw) => {
            let msg: Record<string, unknown>;
            try {
              msg = JSON.parse(
                typeof raw === "string"
                  ? raw
                  : new TextDecoder().decode(raw as unknown as ArrayBuffer),
              );
            } catch {
              return;
            }

            viewerMessages.push(msg as { type: string });

            if (msg.type === "join-viewer") {
              // Phase 1: acknowledge with a WebRTC offer so viewer goes live.
              ws.send(
                JSON.stringify({
                  type: "joined",
                  viewerId: "flip-viewer-001",
                  hasVideo: true,
                  videoMode: "webrtc",
                }),
              );
              // Scoreboard snapshot.
              ws.send(
                JSON.stringify({ type: "scoreboard", teamScore: 24, opponentScore: 18 }),
              );
              // Initial offer — viewer creates PC, connects, goes "live".
              ws.send(
                JSON.stringify({
                  type: "offer",
                  viewerId: "flip-viewer-001",
                  sdp: { type: "offer", sdp: OFFER_SDP },
                }),
              );
            } else if (msg.type === "request-offer") {
              // Phase 2 (post-flip): viewer sent request-offer automatically.
              // Reply with a new offer simulating the broadcaster's new camera stream.
              ws.send(
                JSON.stringify({
                  type: "offer",
                  viewerId: "flip-viewer-001",
                  sdp: { type: "offer", sdp: OFFER_SDP },
                }),
              );
            }
            // answer / ice-candidate: no-op — FakePeerConnection handles ICE internally.
          });
        },
      );

      // Use a large offer-watchdog override so it doesn't interfere with the
      // manual failure we inject below.
      await page.goto(`/watch/${CODE}?__watchOfferS=30`);

      // ── 1. Viewer reaches "live" state after initial offer ─────────────────
      // The video overlay (mute button / fullscreen) is the clearest live-state
      // indicator that doesn't depend on an actual MediaStream in the sandbox.
      await expect(
        page.getByRole("button", { name: /Share/i }),
      ).toBeVisible({ timeout: 10_000 });

      // ── 2. Simulate camera flip: broadcaster closes the viewer's PC ────────
      // This is what closeAllWebRtcPeers() does on the mobile side when
      // cameraFacing changes — each pc.close() causes the viewer's
      // onconnectionstatechange to fire with "failed".
      await page.evaluate(() => {
        (window as any).__hoopsFailCurrentPc();
      });

      // ── 3. Viewer must automatically send request-offer ────────────────────
      // The fix in attachConnectionStateHandlers sends request-offer
      // immediately when s === "failed" and the WS is open — without waiting
      // for the 15-second "Tap to retry" threshold.
      await expect
        .poll(
          () => viewerMessages.filter((m) => m.type === "request-offer").length,
          { timeout: 5_000 },
        )
        .toBeGreaterThan(0);

      // ── 4. Viewer recovers to live after receiving the new offer ───────────
      // FakePeerConnection auto-connects on setRemoteDescription; the component
      // calls setState("live") once ontrack fires.
      await expect(
        page.getByRole("button", { name: /Share/i }),
      ).toBeVisible({ timeout: 8_000 });

      // ── 5. No error / permanent black screen ──────────────────────────────
      await expect(
        page.getByText(/stream not found|error/i),
      ).not.toBeVisible();
      await expect(
        page.getByText(/^Reconnecting…$/)
      ).not.toBeVisible();

      expect(serverWs).not.toBeNull();
    },
  );
});

// ---------------------------------------------------------------------------
// Test B — no crash / no permanent black screen after camera flip
// ---------------------------------------------------------------------------

test.describe("Watch page – camera flip does not leave a black screen", () => {
  test(
    "B – video overlay stays visible and error screen never appears after camera flip",
    async ({ page }) => {
      await page.addInitScript({ content: FAKE_PC_SCRIPT });
      await setupHttpMocks(page);

      await page.routeWebSocket(
        (url) => url.pathname === "/api/live/ws",
        (ws) => {
          ws.onMessage((raw) => {
            let msg: Record<string, unknown>;
            try {
              msg = JSON.parse(
                typeof raw === "string"
                  ? raw
                  : new TextDecoder().decode(raw as unknown as ArrayBuffer),
              );
            } catch {
              return;
            }

            if (msg.type === "join-viewer") {
              ws.send(
                JSON.stringify({
                  type: "joined",
                  viewerId: "flip-viewer-002",
                  hasVideo: true,
                  videoMode: "webrtc",
                }),
              );
              ws.send(
                JSON.stringify({ type: "scoreboard", teamScore: 24, opponentScore: 18 }),
              );
              ws.send(
                JSON.stringify({
                  type: "offer",
                  viewerId: "flip-viewer-002",
                  sdp: { type: "offer", sdp: OFFER_SDP },
                }),
              );
            } else if (msg.type === "request-offer") {
              // Deliver the post-flip offer from the new camera.
              ws.send(
                JSON.stringify({
                  type: "offer",
                  viewerId: "flip-viewer-002",
                  sdp: { type: "offer", sdp: OFFER_SDP },
                }),
              );
            }
          });
        },
      );

      await page.goto(`/watch/${CODE}?__watchOfferS=30`);

      // ── 1. Reach live state ────────────────────────────────────────────────
      await expect(
        page.getByRole("button", { name: /Share/i }),
      ).toBeVisible({ timeout: 10_000 });

      // ── 2. Flip the camera (close the current PC) ─────────────────────────
      await page.evaluate(() => {
        (window as any).__hoopsFailCurrentPc();
      });

      // ── 3. Wait for recovery — video overlay must come back ───────────────
      await expect(
        page.getByRole("button", { name: /Share/i }),
      ).toBeVisible({ timeout: 8_000 });

      // ── 4. Error screen must never appear ─────────────────────────────────
      // "not-found" and "ended" screens both show distinctive copy:
      await expect(page.getByText(/stream not found/i)).not.toBeVisible();
      await expect(page.getByText(/game has ended/i)).not.toBeVisible();
    },
  );
});
