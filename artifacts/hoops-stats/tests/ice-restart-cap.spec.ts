/**
 * ice-restart-cap.spec.ts
 *
 * Confirms the viewer receives `peer-connection-failed` and transitions to
 * the "ended" state — showing "Connection dropped and couldn't be restored."
 * — instead of being left on a frozen, silent frame.
 *
 * Background
 * ----------
 * scorekeeper.tsx caps ICE-restart attempts at 3 per viewer.  After the cap
 * the broadcaster sends `{ type: "peer-connection-failed", targetId: viewerId }`
 * over the signaling WebSocket relay.  The server forwards this message to
 * the target viewer's socket.  The viewer's handler (watch.tsx ~line 866):
 *
 *   mediaFailedRef.current = true;
 *   setState("ended");
 *   pcRef.current?.close();
 *   pcRef.current = null;
 *
 * This path had never been exercised end-to-end.  The test below drives it
 * by mocking the WebSocket relay server so that it:
 *   1. Lets the viewer join and reach the "live" state via a FakePeerConnection.
 *   2. Sends `peer-connection-failed` to the viewer after connection is live.
 *   3. Asserts the viewer renders the disconnection message (not a frozen frame).
 *
 * Test-mode URL params used
 * -------------------------
 *   __watchOfferS=3   — shrinks the offer watchdog to 3 s so it won't fire
 *                        before the test sends peer-connection-failed.
 *   __iceWatchdogMs=… — shrinks the ICE hang watchdog; not used here but
 *                        left explicit so the timing is obvious.
 */

import { test, expect } from "@playwright/test";

const CODE = "ICECAP1";

// Minimal valid SDP offer accepted by the browser's SDP parser.
const OFFER_SDP = [
  "v=0",
  "o=- 1234567890 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE 0",
  "a=msid-semantic: WMS",
  "m=video 9 UDP/TLS/RTP/SAVPF 96",
  "c=IN IP4 0.0.0.0",
  "a=rtcp:9 IN IP4 0.0.0.0",
  "a=ice-ufrag:icecapufrag",
  "a=ice-pwd:icecappassword0000icecappassword0",
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

// FakePeerConnection that simulates a successful ICE handshake:
// setRemoteDescription fires ontrack + connectionState="connected" after a
// short tick so the component reaches state="live".
const FAKE_PC_SCRIPT = `
(function () {
  class FakePeerConnection {
    constructor() {
      this.connectionState    = "new";
      this.iceConnectionState = "new";
      this.ontrack  = null;
      this.onicecandidate = null;
      this.onconnectionstatechange  = null;
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
      }, 200);
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

test.describe("Watch page — peer-connection-failed transitions viewer to ended", () => {
  test(
    "viewer shows 'Connection dropped' when broadcaster sends peer-connection-failed after ICE cap",
    async ({ page }) => {
      // Inject FakePeerConnection so the viewer can reach "live" without a
      // real ICE handshake.
      await page.addInitScript({ content: FAKE_PC_SCRIPT });

      // ── HTTP mocks ──────────────────────────────────────────────────────────

      // ServerReadinessGate health-check.
      await page.route(
        (url) => url.pathname === "/api",
        (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
      );

      // Active session — viewer enters "connecting" state.
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
              teamScore: 42,
              opponentScore: 38,
            }),
          })
      );

      // ICE server config — STUN only; TURN not required for this test.
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
          })
      );

      // ── WebSocket mock ──────────────────────────────────────────────────────
      // 1. Respond to join-viewer with joined (viewerId = "cap-test-viewer").
      // 2. On request-offer: send a valid SDP offer so FakePeerConnection fires
      //    connected and the component reaches state="live".
      // 3. 500 ms after the offer, send peer-connection-failed to simulate the
      //    broadcaster exhausting its ICE restart cap.

      let serverWs: { send: (msg: string) => void } | null = null;

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
                  : new TextDecoder().decode(raw as ArrayBuffer)
              );
            } catch {
              return;
            }

            if (msg.type === "join-viewer") {
              // Acknowledge join with a WebRTC video session.
              ws.send(JSON.stringify({
                type: "joined",
                viewerId: "cap-test-viewer",
                // Omitting hasVideo/videoMode defaults to WebRTC path in watch.tsx.
              }));
            } else if (msg.type === "request-offer") {
              // Send an SDP offer so the FakePeerConnection can connect.
              ws.send(JSON.stringify({
                type: "offer",
                viewerId: "cap-test-viewer",
                sdp: { type: "offer", sdp: OFFER_SDP },
              }));

              // After the viewer reaches "live", simulate the broadcaster
              // exhausting its ICE-restart cap and sending peer-connection-failed.
              // 800 ms gives FakePeerConnection enough time to fire "connected"
              // (200 ms in its setTimeout) and for the component to setState("live").
              setTimeout(() => {
                if (serverWs) {
                  serverWs.send(JSON.stringify({
                    type: "peer-connection-failed",
                    targetId: "cap-test-viewer",
                  }));
                }
              }, 800);
            }
          });
        }
      );

      // ── Navigate — use a 3-second offer watchdog so it doesn't fire before
      //    peer-connection-failed arrives (which takes ~800 ms + page time).
      // waitUntil:"domcontentloaded" avoids blocking on Clerk SDK script loads
      // that can take >45 s on a cold browser context; the SPA renders via JS
      // so we only need the HTML shell to be parsed before assertions begin.
      await page.goto(`/watch/${CODE}?__watchOfferS=3`, { waitUntil: "domcontentloaded" });

      // ── 1. Viewer enters "connecting" state ─────────────────────────────────
      await expect(
        page.getByText(/Joining the stream/)
      ).toBeVisible({ timeout: 10_000 });

      // ── 2. Viewer reaches "live" state (FakePeerConnection fired "connected") ─
      // The video element becomes visible and the connecting overlay disappears.
      await expect(
        page.getByText(/Joining the stream/)
      ).not.toBeVisible({ timeout: 10_000 });

      // ── 3. peer-connection-failed arrives → state transitions to "ended" ────
      // The component renders the disconnected state.
      // The video element must no longer be visible (not a frozen frame).
      await expect(
        page.getByText(/Connection dropped and couldn't be restored/)
      ).toBeVisible({ timeout: 5_000 });

      // The "Refresh and try again" recovery button must be present so the
      // viewer has a clear next action (not a frozen frame with no UI).
      await expect(
        page.getByRole("button", { name: /Refresh and try again/i })
      ).toBeVisible({ timeout: 3_000 });

      // The connecting overlay must be gone (state is not "connecting").
      await expect(
        page.getByText(/Joining the stream/)
      ).not.toBeVisible();

      // The stream-ended "The game has ended" copy must NOT appear
      // (mediaFailed path, not explicit-end path).
      await expect(
        page.getByText(/^The game has ended\.$/)
      ).not.toBeVisible();
    }
  );

  test(
    "viewer shows disconnection UI immediately — not after a delay or reconnect attempt",
    async ({ page }) => {
      // This test verifies that peer-connection-failed bypasses the normal
      // reconnect logic and transitions directly to "ended" without waiting
      // for reconnect delays or watchdog timeouts.

      await page.addInitScript({ content: FAKE_PC_SCRIPT });

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
              opponent: "Away",
              teamName: "Local",
              viewerCount: 0,
              teamScore: 0,
              opponentScore: 0,
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
              turnAvailable: true,
            }),
          })
      );

      const timestamps: { liveAt?: number; endedAt?: number } = {};

      let serverWs2: { send: (msg: string) => void } | null = null;

      await page.routeWebSocket(
        (url) => url.pathname === "/api/live/ws",
        (ws) => {
          serverWs2 = ws;
          ws.onMessage((raw) => {
            let msg: Record<string, unknown>;
            try {
              msg = JSON.parse(
                typeof raw === "string"
                  ? raw
                  : new TextDecoder().decode(raw as ArrayBuffer)
              );
            } catch {
              return;
            }

            if (msg.type === "join-viewer") {
              ws.send(JSON.stringify({ type: "joined", viewerId: "cap-timing-viewer" }));
            } else if (msg.type === "request-offer") {
              ws.send(JSON.stringify({
                type: "offer",
                viewerId: "cap-timing-viewer",
                sdp: { type: "offer", sdp: OFFER_SDP },
              }));

              // Send peer-connection-failed 600 ms after the offer.
              setTimeout(() => {
                if (serverWs2) {
                  serverWs2.send(JSON.stringify({
                    type: "peer-connection-failed",
                    targetId: "cap-timing-viewer",
                  }));
                }
              }, 600);
            }
          });
        }
      );

      await page.goto(`/watch/${CODE}?__watchOfferS=3`);

      // Wait for "live" state then note the timestamp.
      await expect(
        page.getByText(/Joining the stream/)
      ).not.toBeVisible({ timeout: 10_000 });
      timestamps.liveAt = Date.now();

      // "ended" state must appear.
      await expect(
        page.getByText(/Connection dropped and couldn't be restored/)
      ).toBeVisible({ timeout: 5_000 });
      timestamps.endedAt = Date.now();

      // The transition from "live" to "ended" should happen quickly
      // (the broadcaster signals failure immediately — no reconnect backoff).
      // Allow up to 3 seconds: 600 ms WS delay + 200 ms FakePeerConnection
      // + render latency + test framework overhead.
      const elapsed = (timestamps.endedAt ?? 0) - (timestamps.liveAt ?? 0);
      expect(elapsed).toBeLessThan(3_000);

      // The "Reconnecting" banner must NOT appear — peer-connection-failed
      // must not be treated as a WS-level disconnect.
      await expect(page.getByText(/Reconnecting/)).not.toBeVisible();
    }
  );
});
