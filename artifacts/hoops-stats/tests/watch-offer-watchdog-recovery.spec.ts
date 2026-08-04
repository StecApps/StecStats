/**
 * watch-offer-watchdog-recovery.spec.ts
 *
 * Confirms that a viewer automatically recovers to "live" after the
 * offer-watchdog fallback path has already set the state to
 * "waiting-for-broadcaster".
 *
 * Scenario
 * ---------
 * 1. Viewer joins — WS is open, `joined` ACK arrives, but no SDP offer
 *    ever comes (broadcaster is offline / mid-reconnect).
 * 2. First-stage offer watchdog fires → viewer sends `request-offer`
 *    over the still-open WS.
 * 3. Still no offer arrives (second stage expires) → viewer enters
 *    "waiting-for-broadcaster" and the UI shows the "Stream interrupted"
 *    message.
 * 4. Broadcaster comes back online — server pushes a new SDP offer over
 *    the existing viewer WebSocket (no page reload, no new WS connection).
 * 5. Viewer creates a fresh RTCPeerConnection, completes the signaling
 *    handshake, and the component transitions to `state="live"`.
 *
 * Why __offerWatchdogMs is used
 * ------------------------------
 * The offer watchdog is a two-stage real-time timeout (default 30 s each).
 * Waiting 60 s in CI is impractical. The ?__offerWatchdogMs=N URL param
 * (read on mount, never present in production) shrinks both stages so the
 * test completes in well under a second. This is the same pattern used by
 * __watchElapsedS and __watchRetryS for the ICE-stall timer.
 *
 * What is mocked vs what is exercised
 * -------------------------------------
 * Mocked  : HTTP health-gate, live session status, ICE server config,
 *           WS signaling server, RTCPeerConnection (browser layer)
 * Exercised: watch.tsx offer-watchdog state machine, two-stage timeout
 *           logic, WS message handler's recovery path from
 *           "waiting-for-broadcaster" back to "live", signaling handshake
 */

import { test, expect } from "@playwright/test";

const CODE = "WDOG1";

// Minimal SDP offer accepted by the browser's SDP parser.
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
  "a=ice-ufrag:wdogufrag01",
  "a=ice-pwd:wdogpassword01wdogpassword01wdog",
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

// FakePeerConnection that simulates a successful ICE handshake without any
// real network. 300 ms after setRemoteDescription it fires:
//   (a) ontrack with an empty MediaStream  → component sets remoteStreamRef
//   (b) connectionState="connected"        → attachConnectionStateHandlers
//                                             calls setState("live")
// This matches what a real browser produces on a working network.
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

test.describe("Watch page – offer-watchdog fallback and broadcaster recovery", () => {
  test(
    "viewer transitions from waiting-for-broadcaster back to live when broadcaster pushes a new offer",
    async ({ page }) => {

      await page.addInitScript({ content: FAKE_PC_SCRIPT });

      // ── HTTP mocks ─────────────────────────────────────────────────────────

      await page.route(
        (url) => url.pathname === "/api",
        (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
      );

      // Active session so the component enters "connecting" on load.
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
              turnAvailable: false,
            }),
          })
      );

      // ── WebSocket mock ─────────────────────────────────────────────────────

      // Capture the server-side WS handle so we can push a broadcaster offer
      // from outside the onMessage callback (simulating the broadcaster
      // reconnecting and the signaling server forwarding their offer).
      let wsServer: Parameters<Parameters<typeof page.routeWebSocket>[1]>[0] | null = null;
      const requestOfferMessages: Array<{ type: string; code: string }> = [];
      const answerMessages: Array<{ type: string }> = [];

      await page.routeWebSocket(
        (url) => url.pathname === "/api/live/ws",
        (ws) => {
          wsServer = ws;

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
              // ACK the join — deliberately NO offer so the first-stage
              // watchdog must fire.
              ws.send(JSON.stringify({ type: "joined", viewerId: "wdog-viewer-001" }));

            } else if (msg.type === "request-offer") {
              // Record it but do NOT reply with an offer — the second-stage
              // watchdog must be allowed to fire and set
              // "waiting-for-broadcaster".
              requestOfferMessages.push(msg as { type: string; code: string });

            } else if (msg.type === "answer") {
              answerMessages.push(msg as { type: string });
            }
          });
        }
      );

      // ── Navigate with shortened watchdog ───────────────────────────────────
      // __offerWatchdogMs=200 shrinks each watchdog stage from 30 s to 200 ms,
      // letting the two-stage timeout complete in ~400 ms of real time.
      await page.goto(`/watch/${CODE}?__offerWatchdogMs=200`);

      // ── 1. Component enters "connecting" state ─────────────────────────────
      await expect(
        page.getByText(/Joining the stream/)
      ).toBeVisible({ timeout: 10_000 });

      // ── 2. First-stage offer watchdog fires — sends request-offer ──────────
      await expect
        .poll(() => requestOfferMessages.length, { timeout: 5_000 })
        .toBe(1);

      expect(requestOfferMessages[0].type).toBe("request-offer");
      expect(requestOfferMessages[0].code).toBe(CODE);

      // ── 3. Second-stage watchdog fires → waiting-for-broadcaster ───────────
      // The UI shows the "Stream interrupted" waiting message. No offer was
      // returned so the watchdog path must have driven the state transition.
      await expect(
        page.getByText(/Stream interrupted/)
      ).toBeVisible({ timeout: 5_000 });

      // Connecting overlay must be gone.
      await expect(page.getByText(/Joining the stream/)).not.toBeVisible();

      // Only one `request-offer` was sent — the watchdog path doesn't loop.
      expect(requestOfferMessages).toHaveLength(1);

      // ── 4. Broadcaster reconnects — server pushes a new offer over the WS ──
      // The WS is still open; we push directly from the mock server handle.
      expect(wsServer).not.toBeNull();
      wsServer!.send(
        JSON.stringify({
          type: "offer",
          viewerId: "wdog-viewer-001",
          sdp: { type: "offer", sdp: OFFER_SDP },
        })
      );

      // ── 5. Viewer completes signaling handshake ────────────────────────────
      // The component received the offer, created a new RTCPeerConnection,
      // ran setRemoteDescription → createAnswer → setLocalDescription, and
      // sent the answer back over WS.
      await expect
        .poll(() => answerMessages.length, { timeout: 5_000 })
        .toBe(1);

      expect(answerMessages[0].type).toBe("answer");

      // ── 6. Component recovers to live state — no page reload needed ────────
      // FakePeerConnection fires ontrack + connectionState="connected" 300 ms
      // after setRemoteDescription, driving the component to state="live".
      // The "Tap for sound" mute overlay is the first live-state element.
      await expect(
        page.getByText(/Tap for sound/)
      ).toBeVisible({ timeout: 5_000 });

      // Waiting overlay must be gone.
      await expect(page.getByText(/Stream interrupted/)).not.toBeVisible();
    }
  );
});
