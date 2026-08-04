/**
 * watch-retry.spec.ts
 *
 * Confirms that the viewer "Tap to retry" button on the /watch/:code page
 * actually recovers the stalled stream end-to-end:
 *
 *   1. Elapsed timer appears after the stall threshold.
 *   2. "Tap to retry" button appears after the cumulative threshold.
 *   3. Clicking sends `request-offer` over the signaling WebSocket.
 *   4. When the broadcaster replies with a fresh SDP offer, the viewer creates
 *      a new RTCPeerConnection, completes the signaling handshake (answer sent),
 *      and the component transitions to `state="live"`.
 *
 * Why a FakePeerConnection is used
 * ---------------------------------
 * Real WebRTC requires two peers and a working TURN relay. In headless Chromium
 * there are no reachable ICE candidates, so a real RTCPeerConnection immediately
 * transitions to "failed" and never reaches "connected". To verify actual stream
 * recovery we inject a FakePeerConnection via addInitScript that simulates a
 * successful ICE handshake: after setRemoteDescription it fires `ontrack` (with
 * an empty MediaStream) and sets connectionState="connected", which is exactly
 * what the real browser produces on a real network. The component then calls
 * `setState("live")` and renders the live video overlay.
 *
 * What the test mocks vs what it exercises
 * ------------------------------------------
 * Mocked  : HTTP health-gate, live session status, ICE server config, WS
 *           signaling server, RTCPeerConnection (browser layer only)
 * Exercised: watch.tsx state machine, handleManualRetry logic, WS message
 *           parsing, RTCPeerConnection lifecycle callbacks, live-state UI
 */

import { test, expect } from "@playwright/test";

const CODE = "WTST1";

// Minimal SDP offer recognised by the browser's SDP parser. The FakePeerConnection
// never actually uses ICE/DTLS, so the credentials are irrelevant.
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
  "a=ice-ufrag:retryufrag01",
  "a=ice-pwd:retrypassword01retrypassword01r",
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

// FakePeerConnection script injected into the page before load.
// It replaces window.RTCPeerConnection so that setRemoteDescription
// immediately schedules: (a) an ontrack event with an empty MediaStream,
// then (b) connectionState="connected" + onconnectionstatechange.
// This simulates a successful ICE negotiation without any real network,
// letting the component reach state="live" in a deterministic way.
const FAKE_PC_SCRIPT = `
(function () {
  class FakePeerConnection {
    constructor() {
      this.connectionState   = "new";
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
        // Fire ontrack with an empty MediaStream so the component sets
        // remoteStreamRef and calls setState("live").
        if (self.ontrack) {
          const stream = new MediaStream();
          self.ontrack({ track: { kind: "video" }, streams: [stream] });
        }
        // Fire connectionstatechange="connected" so attachConnectionStateHandlers
        // also calls setState("live") and clears the ICE hang watchdog.
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

test.describe("Watch page – ICE stall retry flow", () => {
  test(
    "shows elapsed timer, retry button, sends request-offer, and recovers to live state",
    async ({ page }) => {

      // Inject FakePeerConnection before any page scripts run.
      await page.addInitScript({ content: FAKE_PC_SCRIPT });

      // ── HTTP mocks (URL predicates — avoids glob over-matching) ────────────

      // ServerReadinessGate fetches /api before rendering anything.
      await page.route(
        (url) => url.pathname === "/api",
        (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
      );

      // Active session so the component enters "connecting" state.
      await page.route(
        (url) => url.pathname === `/api/live/${CODE}/status`,
        (route) =>
          route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              active: true,
              opponent: "Away",
              teamName: "Home",
              viewerCount: 0,
              teamScore: 0,
              opponentScore: 0,
            }),
          })
      );

      // STUN-only ICE config.
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

      const requestOfferMessages: Array<{ type: string; code: string }> = [];
      const answerMessages: Array<{ type: string }> = [];

      await page.routeWebSocket(
        (url) => url.pathname === "/api/live/ws",
        (ws) => {
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
              // Acknowledge join — deliberately NO offer so the component stays
              // in "connecting", letting the elapsed timer accumulate.
              ws.send(JSON.stringify({ type: "joined", viewerId: "test-viewer-001" }));

            } else if (msg.type === "request-offer") {
              // Viewer tapped retry — record it, then reply with a fresh offer.
              // FakePeerConnection will process it and simulate success.
              requestOfferMessages.push(msg as { type: string; code: string });
              ws.send(
                JSON.stringify({
                  type: "offer",
                  viewerId: "test-viewer-001",
                  sdp: { type: "offer", sdp: OFFER_SDP },
                })
              );

            } else if (msg.type === "answer") {
              answerMessages.push(msg as { type: string });
            }
          });
        }
      );

      // ── Navigate with reduced thresholds ───────────────────────────────────
      // __watchElapsedS=2  → "Still connecting…" after 2 s
      // __watchRetryS=5    → "Tap to retry" button after 5 s cumulative
      await page.goto(`/watch/${CODE}?__watchElapsedS=2&__watchRetryS=5`);

      // ── 1. Component enters "connecting" state ──────────────────────────────
      await expect(
        page.getByText(/Joining the stream/)
      ).toBeVisible({ timeout: 10_000 });

      // ── 2. Elapsed timer text appears after ≥ 2 s ──────────────────────────
      await expect(
        page.getByText(/Still connecting/)
      ).toBeVisible({ timeout: 10_000 });

      // ── 3. "Tap to retry" button appears after ≥ 5 s cumulative ────────────
      const retryBtn = page.getByRole("button", { name: /Tap to retry/i });
      await expect(retryBtn).toBeVisible({ timeout: 10_000 });

      // ── 4. Clicking sends request-offer over the WS ─────────────────────────
      await retryBtn.click();

      await expect
        .poll(() => requestOfferMessages.length, { timeout: 5_000 })
        .toBeGreaterThan(0);

      expect(requestOfferMessages[0].type).toBe("request-offer");
      expect(requestOfferMessages[0].code).toBe(CODE);

      // ── 5. Viewer completes signaling handshake ─────────────────────────────
      // Mock replied with a fresh offer; the viewer must have run:
      //   setRemoteDescription → createAnswer → setLocalDescription → send answer
      await expect
        .poll(() => answerMessages.length, { timeout: 5_000 })
        .toBeGreaterThan(0);

      expect(answerMessages[0].type).toBe("answer");

      // ── 6. Component recovers to live state ─────────────────────────────────
      // FakePeerConnection fires ontrack + connectionState="connected" 300 ms
      // after setRemoteDescription, which drives the component to state="live".
      // The "Tap for sound" mute overlay is the first live-state element visible.
      await expect(
        page.getByText(/Tap for sound/)
      ).toBeVisible({ timeout: 5_000 });

      // Connecting overlay must be gone.
      await expect(
        page.getByText(/Joining the stream/)
      ).not.toBeVisible();
    }
  );
});
