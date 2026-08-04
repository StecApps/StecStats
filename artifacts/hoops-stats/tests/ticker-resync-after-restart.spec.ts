/**
 * ticker-resync-after-restart.spec.ts
 *
 * Confirms that a viewer already watching a live game sees their stat ticker
 * repopulate — without a page reload — after the signaling server restarts
 * mid-game and the broadcaster reconnects.
 *
 * Scenario
 * ---------
 *   1. Broadcaster has already recorded 3 stats (3-PT Made, Assist, Rebound).
 *   2. Viewer joins /watch/:code and the ticker shows all 3 plays.
 *   3. Server restart is simulated: the WS mock closes the viewer's connection.
 *   4. watch.tsx detects the drop (ws.onclose) → enters "reconnecting" state
 *      and schedules a reconnect after the first delay (1 s).
 *   5. Viewer's WS reconnects; mock re-delivers joined + scoreboard +
 *      stat-events (same 3 plays, mirroring the broadcaster's resync-events
 *      flow that the server fans out on join-viewer after restart).
 *   6. Viewer obtains a fresh offer → FakePeerConnection fires "connected"
 *      → state returns to "live".
 *   7. Ticker shows the same 3 plays — no page reload was required.
 *
 * What is mocked vs exercised
 * ----------------------------
 * Mocked  : HTTP health-gate, live-session status, ICE server config,
 *           WS signaling server, RTCPeerConnection (browser layer only)
 * Exercised: watch.tsx reconnect state machine, stat-events / stat-event
 *           message handlers, setStatEvents clearing on reconnect, and
 *           repopulation via the stat-events message on the new connection.
 */

import { test, expect } from "@playwright/test";

const CODE = "RSNC1";

const OFFER_SDP =
  [
    "v=0",
    "o=- 1234567890 2 IN IP4 127.0.0.1",
    "s=-",
    "t=0 0",
    "a=group:BUNDLE 0",
    "a=msid-semantic: WMS",
    "m=video 9 UDP/TLS/RTP/SAVPF 96",
    "c=IN IP4 0.0.0.0",
    "a=rtcp:9 IN IP4 0.0.0.0",
    "a=ice-ufrag:resyncufrag01",
    "a=ice-pwd:resyncpassword01resyncpassword01r",
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

// FakePeerConnection — identical to watch-retry.spec.ts.
// After setRemoteDescription it fires ontrack then connectionState="connected"
// so the component reaches state="live" without a real ICE negotiation.
const FAKE_PC_SCRIPT = `
(function () {
  class FakePeerConnection {
    constructor() {
      this.connectionState    = "new";
      this.iceConnectionState = "new";
      this.ontrack = null;
      this.onicecandidate = null;
      this.onconnectionstatechange = null;
      this.oniceconnectionstatechange = null;
      this._closed = false;
    }

    async setRemoteDescription(_desc) {
      if (this._closed) return;
      const self = this;
      setTimeout(function () {
        if (self._closed) return;
        if (self.ontrack) {
          const stream = new MediaStream();
          self.ontrack({ track: { kind: "video" }, streams: [stream] });
        }
        self.connectionState    = "connected";
        self.iceConnectionState = "connected";
        if (self.onconnectionstatechange)  self.onconnectionstatechange();
        if (self.oniceconnectionstatechange) self.oniceconnectionstatechange();
      }, 300);
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
    }
  }

  window.RTCPeerConnection = FakePeerConnection;
})();
`;

// The three stat plays the "broadcaster" recorded before the restart.
const PRIOR_EVENTS = [
  { id: "ev1", playerName: "Jordan", label: "3PT Made", timestamp: Date.now() - 90_000 },
  { id: "ev2", playerName: "James",  label: "Assist",   timestamp: Date.now() - 60_000 },
  { id: "ev3", playerName: "Kobe",   label: "Rebound",  timestamp: Date.now() - 30_000 },
];

/** Send joined + scoreboard + stat-events + offer to a WS mock handle. */
function sendInitialPayload(
  ws: import("@playwright/test").WebSocketRoute,
  viewerId: string,
) {
  ws.send(JSON.stringify({ type: "joined", viewerId }));
  ws.send(JSON.stringify({ type: "scoreboard", teamScore: 7, opponentScore: 4 }));
  ws.send(JSON.stringify({ type: "stat-events", events: PRIOR_EVENTS }));
  // Send the offer so FakePeerConnection can drive the component to "live".
  ws.send(
    JSON.stringify({
      type: "offer",
      viewerId,
      sdp: { type: "offer", sdp: OFFER_SDP },
    })
  );
}

test.describe("Watch page – ticker resync after server restart", () => {
  test(
    "ticker repopulates with prior plays after WS reconnects — no page reload",
    async ({ page }) => {
      await page.addInitScript({ content: FAKE_PC_SCRIPT });

      // ── HTTP mocks ──────────────────────────────────────────────────────────
      await page.route(
        (url) => url.pathname === "/api",
        (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
      );

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
              viewerCount: 1,
              teamScore: 7,
              opponentScore: 4,
            }),
          })
      );

      await page.route(
        (url) => url.pathname === "/api/live/ice-servers",
        (route) =>
          route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
              turnAvailable: false,
            }),
          })
      );

      // ── WebSocket mock ──────────────────────────────────────────────────────
      // connectionCount tracks how many times the viewer's WS has connected.
      // Phase 1 (count === 1): send initial payload, then close the socket to
      //   simulate the server restarting mid-game.
      // Phase 2 (count === 2): send the same payload again, mirroring what the
      //   real server does after the broadcaster resends resync-events on its
      //   reconnect: the server fans the repopulated list out to all viewers on
      //   join-viewer.
      let connectionCount = 0;
      // Hold a reference to the first mock WS so we can close it later.
      let firstWs: import("@playwright/test").WebSocketRoute | null = null;

      await page.routeWebSocket(
        (url) => url.pathname === "/api/live/ws",
        (ws) => {
          connectionCount += 1;
          const connIndex = connectionCount;

          ws.onMessage((raw) => {
            let msg: Record<string, unknown>;
            try {
              msg = JSON.parse(
                typeof raw === "string"
                  ? raw
                  : new TextDecoder().decode(raw as unknown as ArrayBuffer)
              );
            } catch {
              return;
            }

            if (msg.type === "join-viewer") {
              if (connIndex === 1) {
                // ── Phase 1: initial connection ────────────────────────────
                // Save reference so we can close it after verifying the ticker.
                firstWs = ws;
                sendInitialPayload(ws, "viewer-rsync-001");
              } else {
                // ── Phase 2: reconnect after simulated restart ─────────────
                // Re-deliver the same events: this is what the real server does
                // because the broadcaster already sent resync-events and the
                // server stored them in session.recentEvents, which it fans out
                // to every new join-viewer call.
                sendInitialPayload(ws, "viewer-rsync-002");
              }
            }
            // answer / ice-candidate messages are ignored — FakePeerConnection
            // doesn't need the signaling round-trip to reach "connected".
          });
        }
      );

      // ── 1. Navigate to watch page ───────────────────────────────────────────
      await page.goto(`/watch/${CODE}`);

      // ── 2. Component reaches "live" state ───────────────────────────────────
      // "Tap for sound" mute overlay is the first live-state element visible.
      await expect(page.getByText(/Tap for sound/i)).toBeVisible({ timeout: 10_000 });

      // ── 3. Ticker shows all 3 prior plays ───────────────────────────────────
      await expect(page.getByText("3PT Made")).toBeVisible({ timeout: 5_000 });
      await expect(page.getByText("Assist")).toBeVisible({ timeout: 5_000 });
      await expect(page.getByText("Rebound")).toBeVisible({ timeout: 5_000 });
      await expect(page.getByText("Jordan")).toBeVisible();
      await expect(page.getByText("James")).toBeVisible();
      await expect(page.getByText("Kobe")).toBeVisible();

      // ── 4. Simulate server restart: drop the viewer's WS connection ─────────
      // The watch.tsx ws.onclose handler will enter "reconnecting" state and
      // schedule a reconnect after WATCH_RECONNECT_DELAYS_MS[0] = 1 000 ms.
      expect(firstWs).not.toBeNull();
      await firstWs!.close();

      // ── 5. Component enters "reconnecting" state ────────────────────────────
      await expect(
        page.getByText(/Reconnecting/i)
      ).toBeVisible({ timeout: 5_000 });

      // ── 6. Component reconnects and returns to "live" state ─────────────────
      // The reconnect fires after 1 s; allow up to 8 s total for the full cycle:
      // reconnect delay (1 s) + WS handshake + FakePeerConnection settling (0.3 s).
      await expect(page.getByText(/Tap for sound/i)).toBeVisible({ timeout: 8_000 });

      // ── 7. Ticker repopulates without a page reload ─────────────────────────
      // watch.tsx clears statEvents on reconnect (setStatEvents([])) and then
      // the server's stat-events message refills them.  All 3 prior plays must
      // be visible again — confirming the resync path works end-to-end.
      await expect(page.getByText("3PT Made")).toBeVisible({ timeout: 5_000 });
      await expect(page.getByText("Assist")).toBeVisible({ timeout: 5_000 });
      await expect(page.getByText("Rebound")).toBeVisible({ timeout: 5_000 });
      await expect(page.getByText("Jordan")).toBeVisible();
      await expect(page.getByText("James")).toBeVisible();
      await expect(page.getByText("Kobe")).toBeVisible();

      // Sanity: connection count must be exactly 2 — one initial, one reconnect.
      expect(connectionCount).toBe(2);
    }
  );
});
