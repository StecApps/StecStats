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

// Stalling FakePeerConnection: the FIRST instance's setRemoteDescription does
// nothing (simulates a stuck ICE negotiation that never reaches "connected"),
// triggering the automatic 20-second hang watchdog. The SECOND instance
// succeeds immediately, letting the component reach state="live".
// A global counter on window tracks which instance is being constructed.
const STALLING_FAKE_PC_SCRIPT = `
(function () {
  var __fpcCount = 0;

  class StallingFakePeerConnection {
    constructor() {
      this.connectionState    = "new";
      this.iceConnectionState = "new";
      this.ontrack = null;
      this.onicecandidate = null;
      this.onconnectionstatechange = null;
      this.oniceconnectionstatechange = null;
      this._closed = false;
      this._index  = __fpcCount++;
    }

    async setRemoteDescription(_desc) {
      if (this._closed) return;
      if (this._index === 0) {
        // First PC: intentionally stall — the ICE hang watchdog must recover.
        return;
      }
      // Second PC: succeed after a short tick so the test resolves quickly.
      var self = this;
      setTimeout(function () {
        if (self._closed) return;
        if (self.ontrack) {
          var stream = new MediaStream();
          self.ontrack({ track: { kind: "video" }, streams: [stream] });
        }
        self.connectionState    = "connected";
        self.iceConnectionState = "connected";
        if (self.onconnectionstatechange)  self.onconnectionstatechange();
        if (self.oniceconnectionstatechange) self.oniceconnectionstatechange();
      }, 100);
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

  window.RTCPeerConnection = StallingFakePeerConnection;
})();
`;

test.describe("Watch page – reconnecting state retry flow", () => {
  test(
    "offer watchdog falls back to waiting-for-broadcaster when retry is tapped in reconnecting state",
    async ({ page }) => {
      // This test verifies the guard fix in handleManualRetry:
      //   setState((prev) => prev === "connecting" || prev === "reconnecting"
      //     ? "waiting-for-broadcaster" : prev)
      //
      // Scenario: viewer's WS drops mid-game → state = "reconnecting".
      // WS auto-reconnects (fast, delay=0). getLiveStatus is intentionally
      // slow (2 s) so the viewer stays in "reconnecting" while the WS is
      // already open again. The viewer taps "Tap to retry" — this arms the
      // offer watchdog. No offer arrives. The watchdog fires and must
      // transition to "waiting-for-broadcaster" (not silently no-op).

      await page.addInitScript({ content: FAKE_PC_SCRIPT });

      // ── HTTP mocks ─────────────────────────────────────────────────────────

      await page.route(
        (url) => url.pathname === "/api",
        (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
      );

      // First call (mount): instant active response so component starts connecting.
      // Second call (after WS reconnect): slow (3 s) so state stays "reconnecting"
      // long enough for the test to click the button while the WS is open.
      let statusCallCount = 0;
      await page.route(
        (url) => url.pathname === `/api/live/${CODE}/status`,
        async (route) => {
          statusCallCount++;
          if (statusCallCount === 1) {
            await route.fulfill({
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
            });
          } else {
            // Delay the reconnect status response so state stays "reconnecting"
            // while the WS is already open — this is the window the test exercises.
            await new Promise<void>((r) => setTimeout(r, 3000));
            await route.fulfill({
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
            });
          }
        }
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
      // First WS connection: acknowledge join, then immediately close so the
      // component enters "reconnecting" state.
      // Second WS connection (reconnect): acknowledge join, stay open, but never
      // send an offer — this is what the offer watchdog should eventually detect.
      let wsConnectionCount = 0;
      let serverWs: { send: (msg: string) => void; close: () => void } | null = null;

      await page.routeWebSocket(
        (url) => url.pathname === "/api/live/ws",
        (ws) => {
          wsConnectionCount++;
          const connIndex = wsConnectionCount;
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
              ws.send(JSON.stringify({ type: "joined", viewerId: "test-viewer-reconnect" }));
              if (connIndex === 1) {
                // First connection: close immediately to trigger "reconnecting"
                ws.close();
              }
              // Second connection: stay open, never send an offer
            }
            // Intentionally ignore request-offer — no offer will arrive
          });
        }
      );

      // ── Navigate with fast reconnect and short offer watchdog ──────────────
      // __watchReconnectDelayMs=0  → reconnect fires immediately (no 1s delay)
      // __watchOfferS=2            → offer watchdog fires after 2 s
      await page.goto(
        `/watch/${CODE}?__watchReconnectDelayMs=0&__watchOfferS=2`
      );

      // ── 1. WS closes immediately → state enters "reconnecting" ─────────────
      // ("Joining the stream" is intentionally not asserted — the WS closes
      // so fast that "connecting" is transient and Playwright may miss it.)
      await expect(page.getByText(/Reconnecting/)).toBeVisible({ timeout: 10_000 });

      // ── 2. "Tap to retry" button appears in reconnecting state ──────────────
      const retryBtn = page.getByRole("button", { name: /Tap to retry/i });
      await expect(retryBtn).toBeVisible({ timeout: 10_000 });

      // ── 3. WS has reconnected (second connection opened by this point) ──────
      // The WS is open but getLiveStatus is still pending, so state stays
      // "reconnecting". Click retry to arm the offer watchdog.
      await retryBtn.click();

      // ── 4. No offer arrives → watchdog transitions to waiting-for-broadcaster ─
      // The offer watchdog fires after ~2 s and checks:
      //   prev === "connecting" || prev === "reconnecting" → "waiting-for-broadcaster"
      await expect(
        page.getByText(/Stream interrupted|Game hasn't started yet/)
      ).toBeVisible({ timeout: 10_000 });

      // Reconnecting overlay must be gone.
      await expect(page.getByText(/^Reconnecting…$/)).not.toBeVisible();
    }
  );
});

test.describe("Watch page – ICE stall retry flow", () => {
  test(
    "offer watchdog fires after silent retry — shows waiting-for-broadcaster, not a spinner",
    async ({ page }) => {
      // No FakePeerConnection needed — no offer arrives, so no RTCPeerConnection
      // is ever created. The test only cares about the state-machine fallback.

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
              opponent: "Away",
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

      // ── WebSocket mock — receives request-offer but never replies ───────────
      const requestOfferMessages: Array<{ type: string; code: string }> = [];

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
              // Acknowledge join — send NO offer so the component stays in "connecting".
              ws.send(JSON.stringify({ type: "joined", viewerId: "test-viewer-watchdog" }));
            } else if (msg.type === "request-offer") {
              // Record it but deliberately do NOT send an offer back.
              // This simulates a broadcaster that is unreachable/offline.
              requestOfferMessages.push(msg as { type: string; code: string });
            }
          });
        }
      );

      // ── Navigate with reduced thresholds ───────────────────────────────────
      // __watchElapsedS=1  → "Still connecting…" after 1 s
      // __watchRetryS=2    → "Tap to retry" button after 2 s cumulative
      // __offerWatchdogMs=3000 → offer watchdog fires after 3 s (not 30 s).
      //
      // Why 3000 ms and not something tiny like 500 ms:
      //   watch.tsx has a *proactive* offer watchdog set in ws.onopen that
      //   also uses OFFER_WATCHDOG_MS.  With a tiny value (e.g. 500 ms) that
      //   proactive watchdog fires two stages — at 500 ms and 1000 ms — and
      //   transitions the component to "waiting-for-broadcaster" automatically
      //   before the 2-second retry button even appears, so the test can never
      //   click it.  Using 3000 ms means:
      //     • the retry button appears at ~2 s,
      //     • clicking it clears the pending proactive watchdog,
      //     • the manual-retry watchdog fires at ~2+3 = ~5 s,
      //     • the component transitions to "waiting-for-broadcaster" as expected.
      await page.goto(
        `/watch/${CODE}?__watchElapsedS=1&__watchRetryS=2&__offerWatchdogMs=3000`
      );

      // ── 1. Component enters "connecting" state ──────────────────────────────
      await expect(
        page.getByText(/Joining the stream/)
      ).toBeVisible({ timeout: 10_000 });

      // ── 2. "Tap to retry" button appears after ≥ 2 s ───────────────────────
      const retryBtn = page.getByRole("button", { name: /Tap to retry/i });
      await expect(retryBtn).toBeVisible({ timeout: 10_000 });

      // ── 3. Click retry — WS sends request-offer ─────────────────────────────
      await retryBtn.click();

      await expect
        .poll(() => requestOfferMessages.length, { timeout: 5_000 })
        .toBeGreaterThan(0);

      expect(requestOfferMessages[0].type).toBe("request-offer");
      expect(requestOfferMessages[0].code).toBe(CODE);

      // ── 4. Watchdog fires (≤ 500 ms + React tick) → waiting-for-broadcaster ─
      // The component must show the "Stream interrupted" message, NOT a spinner.
      await expect(
        page.getByText(/Stream interrupted/)
      ).toBeVisible({ timeout: 5_000 });

      // Ensure the "Joining the stream…" connecting overlay is gone.
      await expect(
        page.getByText(/Joining the stream/)
      ).not.toBeVisible();

      // The "Check again" button must be present on the waiting-for-broadcaster screen.
      await expect(
        page.getByRole("button", { name: /Check again/i })
      ).toBeVisible({ timeout: 3_000 });
    }
  );

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
                  : new TextDecoder().decode(raw as unknown as ArrayBuffer)
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

  test(
    "automatic ICE-hang watchdog recovers to live state without manual retry",
    async ({ page }) => {

      // Inject the stalling FakePeerConnection. The first PC stalls (no
      // ontrack / connected), the second one succeeds after 100 ms.
      await page.addInitScript({ content: STALLING_FAKE_PC_SCRIPT });

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
              opponent: "Away",
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
              // Acknowledge join then immediately send an offer so the first
              // (stalling) FakePeerConnection is created right away.
              ws.send(JSON.stringify({ type: "joined", viewerId: "test-viewer-001" }));
              ws.send(
                JSON.stringify({
                  type: "offer",
                  viewerId: "test-viewer-001",
                  sdp: { type: "offer", sdp: OFFER_SDP },
                })
              );

            } else if (msg.type === "request-offer") {
              // ICE watchdog fired — record it and reply with a second offer.
              // The second StallingFakePeerConnection will succeed.
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

      // ── Navigate with a very short ICE watchdog so the test runs fast ───────
      // __iceWatchdogMs=500  → watchdog fires 500 ms after stalling offer received
      // __watchRetryS=9999   → "Tap to retry" button must NOT appear (watchdog only)
      // __offerWatchdogMs=5000 → offer watchdog won't race against ICE watchdog
      await page.goto(
        `/watch/${CODE}?__iceWatchdogMs=500&__watchRetryS=9999&__offerWatchdogMs=5000`
      );

      // ── 1. Component enters "connecting" state ──────────────────────────────
      await expect(
        page.getByText(/Joining the stream/)
      ).toBeVisible({ timeout: 10_000 });

      // ── 2. Manual "Tap to retry" button must NOT appear ─────────────────────
      // (cumulative threshold is 9999 s so the button won't show)
      await expect(
        page.getByRole("button", { name: /Tap to retry/i })
      ).not.toBeVisible();

      // ── 3. Watchdog fires: request-offer is sent automatically ──────────────
      await expect
        .poll(() => requestOfferMessages.length, { timeout: 5_000 })
        .toBeGreaterThan(0);

      expect(requestOfferMessages[0].type).toBe("request-offer");
      expect(requestOfferMessages[0].code).toBe(CODE);

      // ── 4. Second PC completes the signaling handshake ──────────────────────
      await expect
        .poll(() => answerMessages.length, { timeout: 5_000 })
        .toBeGreaterThanOrEqual(2); // one from the stalling PC, one from the live PC

      // ── 5. Component reaches live state automatically ───────────────────────
      await expect(
        page.getByText(/Tap for sound/)
      ).toBeVisible({ timeout: 5_000 });

      await expect(
        page.getByText(/Joining the stream/)
      ).not.toBeVisible();
    }
  );
});
