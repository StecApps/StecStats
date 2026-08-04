/**
 * watch-check-again.spec.ts
 *
 * Confirms that the "Check again" button on the waiting-for-broadcaster screen
 * calls getLiveStatus and, when the broadcast is now active, transitions the
 * viewer to "connecting" → "live" without a page reload.
 *
 * Scenario
 * ---------
 * 1. Viewer navigates to /watch/:code — getLiveStatus returns active:false,
 *    so the component enters "waiting-for-broadcaster" and shows
 *    "Stream interrupted — staying connected."
 * 2. Broadcaster goes live in the background (getLiveStatus will now return
 *    active:true on the next call).
 * 3. Viewer taps "Check again" — component calls getLiveStatus, gets
 *    active:true, sets state="connecting" and sends request-offer over the
 *    already-open WebSocket.
 * 4. WS mock replies with a fresh SDP offer; FakePeerConnection completes the
 *    ICE handshake and the component reaches state="live".
 * 5. A second test confirms the button is disabled and shows a countdown for
 *    ~10 s after each tap (rate-limit guard), regardless of whether the
 *    broadcast is active.
 *
 * What is mocked vs what is exercised
 * -------------------------------------
 * Mocked  : HTTP health-gate, live session status (two-phase response),
 *           ICE server config, WS signaling server, RTCPeerConnection
 * Exercised: watch.tsx handleCheckAgain, checkAgainCooldown state machine,
 *            WS request-offer dispatch, signaling handshake recovery path,
 *            disabled-button UI while cooldown is running
 */

import { test, expect } from "@playwright/test";

const CODE = "CHKAG1";

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
  "a=ice-ufrag:chkagufrag01",
  "a=ice-pwd:chkagpassword01chkagpassword01ch",
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

// FakePeerConnection: after setRemoteDescription fires ontrack + "connected"
// after 300 ms, simulating a successful ICE handshake without any real network.
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

test.describe("Watch page – 'Check again' button transitions viewer to stream", () => {
  test(
    "tapping 'Check again' when broadcast becomes active transitions to connecting then live",
    async ({ page }) => {

      await page.addInitScript({ content: FAKE_PC_SCRIPT });

      // ── HTTP mocks ─────────────────────────────────────────────────────────

      await page.route(
        (url) => url.pathname === "/api",
        (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
      );

      // Two-phase status: first call (on mount) returns inactive so the
      // component enters "waiting-for-broadcaster". Second call (from
      // handleCheckAgain) returns active so the component sends request-offer.
      let statusCallCount = 0;
      await page.route(
        (url) => url.pathname === `/api/live/${CODE}/status`,
        (route) => {
          statusCallCount += 1;
          const active = statusCallCount >= 2;
          route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              active,
              opponent: "Visitors",
              teamName: "Home",
              viewerCount: 0,
              teamScore: 0,
              opponentScore: 0,
            }),
          });
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

      // ── WebSocket mock ─────────────────────────────────────────────────────

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
              ws.send(JSON.stringify({ type: "joined", viewerId: "chk-viewer-003" }));
            }
            // No offer reply — the broadcast is still inactive.
          });
        }
      );

      // ── Navigate ──────────────────────────────────────────────────────────
      await page.goto(`/watch/${CODE}?__offerWatchdogMs=5000&__watchRetryS=9999`);

      // ── 1. Component enters "waiting-for-broadcaster" ─────────────────────
      await expect(
        page.getByText(/Stream interrupted/)
      ).toBeVisible({ timeout: 10_000 });

      // ── 2. "Check again" button is enabled ───────────────────────────────
      const checkBtn = page.getByRole("button", { name: /Check again/i });
      await expect(checkBtn).toBeVisible({ timeout: 5_000 });
      await expect(checkBtn).toBeEnabled();

      // ── 3. Tap "Check again" ─────────────────────────────────────────────
      await checkBtn.click();

      // ── 4. Component transitions to "connecting" ─────────────────────────
      // getLiveStatus returned active:true → setState("connecting")
      await expect(
        page.getByText(/Joining the stream/)
      ).toBeVisible({ timeout: 5_000 });

      // Waiting-for-broadcaster overlay must be gone.
      await expect(page.getByText(/Stream interrupted/)).not.toBeVisible();

      // ── 5. request-offer was sent over the WS ───────────────────────────
      await expect
        .poll(() => requestOfferMessages.length, { timeout: 5_000 })
        .toBe(1);

      expect(requestOfferMessages[0].type).toBe("request-offer");
      expect(requestOfferMessages[0].code).toBe(CODE);

      // ── 6. Viewer completes the signaling handshake ──────────────────────
      await expect
        .poll(() => answerMessages.length, { timeout: 5_000 })
        .toBe(1);

      expect(answerMessages[0].type).toBe("answer");

      // ── 7. Component reaches live state ─────────────────────────────────
      // FakePeerConnection fires ontrack + connectionState="connected" 300 ms
      // after setRemoteDescription. The "Tap for sound" overlay is the first
      // visible live-state element.
      await expect(
        page.getByText(/Tap for sound/)
      ).toBeVisible({ timeout: 5_000 });

      await expect(page.getByText(/Joining the stream/)).not.toBeVisible();
    }
  );

  test(
    "button is disabled and shows a countdown for ~10 s after each tap",
    async ({ page }) => {

      await page.addInitScript({ content: FAKE_PC_SCRIPT });

      // ── HTTP mocks ─────────────────────────────────────────────────────────

      await page.route(
        (url) => url.pathname === "/api",
        (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
      );

      // Always inactive so the component stays on the waiting screen and the
      // button cooldown behaviour can be observed.
      await page.route(
        (url) => url.pathname === `/api/live/${CODE}/status`,
        (route) =>
          route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              active: false,
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
              ws.send(JSON.stringify({ type: "joined", viewerId: "chk-viewer-003" }));
            }
            // No offer reply — the broadcast is still inactive.
          });
        }
      );

      // ── Navigate ──────────────────────────────────────────────────────────
      await page.goto(`/watch/${CODE}?__offerWatchdogMs=5000&__watchRetryS=9999`);

      // ── 1. Component enters "waiting-for-broadcaster" ─────────────────────
      await expect(
        page.getByText(/Stream interrupted/)
      ).toBeVisible({ timeout: 10_000 });

      // ── 2. "Check again" button is enabled ───────────────────────────────
      const checkBtn = page.getByRole("button", { name: /Check again/i });
      await expect(checkBtn).toBeVisible({ timeout: 5_000 });
      await expect(checkBtn).toBeEnabled();

      // ── 3. Tap "Check again" ─────────────────────────────────────────────
      await checkBtn.click();

      // ── 4. Button immediately shows a cooldown countdown and is disabled ─
      // The label changes to "Check again (Ns)" where N is 1–10.
      await expect(
        page.getByRole("button", { name: /Check again \(\d+s\)/i })
      ).toBeVisible({ timeout: 3_000 });

      await expect(
        page.getByRole("button", { name: /Check again \(\d+s\)/i })
      ).toBeDisabled();

      // ── 5. The component stays on the waiting screen (active was false) ──
      await expect(page.getByText(/Stream interrupted/)).toBeVisible();
      await expect(page.getByText(/Joining the stream/)).not.toBeVisible();
    }
  );

  test(
    "shows inline error feedback and still runs the cooldown when the status request fails",
    async ({ page }) => {

      await page.addInitScript({ content: FAKE_PC_SCRIPT });

      // ── HTTP mocks ─────────────────────────────────────────────────────────

      await page.route(
        (url) => url.pathname === "/api",
        (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
      );

      // First call (on mount) — inactive so the component enters
      // "waiting-for-broadcaster".  Second call (from handleCheckAgain) —
      // aborted to simulate a network failure / total outage, causing
      // getLiveStatus to throw so the catch branch in handleCheckAgain fires.
      let statusCallCount = 0;
      await page.route(
        (url) => url.pathname === `/api/live/${CODE}/status`,
        (route) => {
          statusCallCount += 1;
          if (statusCallCount === 1) {
            // Mount-time probe — broadcaster not live yet.
            route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({
                active: false,
                opponent: "Visitors",
                teamName: "Home",
                viewerCount: 0,
                teamScore: 0,
                opponentScore: 0,
              }),
            });
          } else {
            // "Check again" probe — abort to simulate a network error so
            // fetch() throws and handleCheckAgain's catch block fires.
            route.abort("failed");
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

      // ── WebSocket mock ─────────────────────────────────────────────────────

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
              ws.send(JSON.stringify({ type: "joined", viewerId: "chk-viewer-003" }));
            }
            // No offer reply — the broadcast is still inactive.
          });
        }
      );

      // ── Navigate ──────────────────────────────────────────────────────────
      await page.goto(`/watch/${CODE}?__offerWatchdogMs=5000&__watchRetryS=9999`);

      // ── 1. Component enters "waiting-for-broadcaster" ─────────────────────
      await expect(
        page.getByText(/Stream interrupted/)
      ).toBeVisible({ timeout: 10_000 });

      // ── 2. "Check again" button is enabled ───────────────────────────────
      const checkBtn = page.getByRole("button", { name: /Check again/i });
      await expect(checkBtn).toBeVisible({ timeout: 5_000 });
      await expect(checkBtn).toBeEnabled();

      // ── 3. Tap "Check again" ─────────────────────────────────────────────
      await checkBtn.click();

      // ── 4. Component stays on "waiting-for-broadcaster" ──────────────────
      // The error path must NOT transition to "connecting".
      await expect(page.getByText(/Stream interrupted/)).toBeVisible({ timeout: 5_000 });
      await expect(page.getByText(/Joining the stream/)).not.toBeVisible();

      // ── 5. Inline error feedback is visible ──────────────────────────────
      await expect(
        page.getByRole("alert")
      ).toBeVisible({ timeout: 5_000 });

      await expect(
        page.getByRole("alert")
      ).toContainText(/check your connection/i);

      // ── 6. Cooldown still starts (button becomes disabled with countdown) ─
      await expect(
        page.getByRole("button", { name: /Check again \(\d+s\)/i })
      ).toBeVisible({ timeout: 3_000 });

      await expect(
        page.getByRole("button", { name: /Check again \(\d+s\)/i })
      ).toBeDisabled();
    }
  );

  test(
    "falls back to waiting-for-broadcaster via watchdog when WS is closed before Check again is tapped",
    async ({ page }) => {

      // Replace WebSocket with a permanently-CLOSED stub so that when
      // handleCheckAgain checks wsRef.current?.readyState === WebSocket.OPEN
      // it gets false — exactly the scenario the bug report describes.
      // The stub never fires onopen / onclose / onmessage so the component
      // stays on the waiting-for-broadcaster screen (it enters that screen
      // because the initial getLiveStatus returns active:false, not because
      // of WS state).
      await page.addInitScript(`
        (function () {
          function FakeClosedWS() {
            this.readyState  = 3;   // WebSocket.CLOSED
            this.send        = function () {};
            this.close       = function () {};
            this.onopen      = null;
            this.onclose     = null;
            this.onmessage   = null;
            this.onerror     = null;
            this.addEventListener    = function () {};
            this.removeEventListener = function () {};
          }
          FakeClosedWS.CONNECTING = 0;
          FakeClosedWS.OPEN       = 1;
          FakeClosedWS.CLOSING    = 2;
          FakeClosedWS.CLOSED     = 3;
          window.WebSocket = FakeClosedWS;
        })();
      `);

      // ── HTTP mocks ────────────────────────────────────────────────────────

      await page.route(
        (url) => url.pathname === "/api",
        (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
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

      // Two-phase status: first call (on mount) → inactive so viewer waits;
      // second call (from handleCheckAgain) → active so state = "connecting".
      let statusCallCount = 0;
      await page.route(
        (url) => url.pathname === `/api/live/${CODE}/status`,
        (route) => {
          statusCallCount += 1;
          route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              active: statusCallCount >= 2,
              opponent: "Visitors",
              teamName: "Home",
              viewerCount: 0,
              teamScore: 0,
              opponentScore: 0,
            }),
          });
        }
      );

      // ── Navigate ──────────────────────────────────────────────────────────
      // __offerWatchdogMs=800  keeps the test fast; the watchdog fires in 800 ms
      // when no offer arrives (because the WS is always CLOSED).
      // __watchRetryS / __watchElapsedS are set high so unrelated UI doesn't
      // interfere with the assertions below.
      await page.goto(
        `/watch/${CODE}?__offerWatchdogMs=800&__watchRetryS=9999&__watchElapsedS=9999`
      );

      // ── 1. Component enters waiting-for-broadcaster ───────────────────────
      await expect(
        page.getByText(/Stream interrupted/)
      ).toBeVisible({ timeout: 10_000 });

      // Connecting overlay must not be showing.
      await expect(page.getByText(/Joining the stream/)).not.toBeVisible();

      // ── 2. "Check again" button is visible and enabled ───────────────────
      const checkBtnWs = page.getByRole("button", { name: /Check again/i });
      await expect(checkBtnWs).toBeVisible({ timeout: 5_000 });
      await expect(checkBtnWs).toBeEnabled();

      // ── 3. Tap "Check again" ─────────────────────────────────────────────
      await checkBtnWs.click();

      // ── 4. Component transitions to "connecting" ──────────────────────────
      // getLiveStatus returned active:true so handleCheckAgain calls
      // setState("connecting"). The viewer leaves the waiting screen.
      await expect(
        page.getByText(/Joining the stream/)
      ).toBeVisible({ timeout: 5_000 });

      await expect(page.getByText(/Stream interrupted/)).not.toBeVisible();

      // ── 5. Offer watchdog fires and returns to waiting-for-broadcaster ─────
      // The WS is permanently CLOSED so no offer ever arrives. The 800 ms
      // watchdog (armed unconditionally after the fix) must fire and transition
      // back — the viewer must never be permanently stuck on "connecting".
      await expect(
        page.getByText(/Stream interrupted/)
      ).toBeVisible({ timeout: 5_000 });

      await expect(page.getByText(/Joining the stream/)).not.toBeVisible();
    }
  );
});
