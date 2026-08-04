/**
 * watch-unmount-no-stale-updates.spec.ts
 *
 * Verifies that navigating away from the watch page while a WS-level reconnect
 * is in progress does NOT leave dangling timers that fire React state-update
 * calls on the now-unmounted component.
 *
 * Specifically exercised timers
 * ─────────────────────────────
 * reconnectTimerRef  — 1 s setInterval that ticks the elapsed/countdown
 *   counters in the "Reconnecting…" banner.  Started by the effect at
 *   watch.tsx when `state === "reconnecting"`.  The cleanup return fires on
 *   both state change and unmount; we confirm it actually fires on unmount.
 *
 * reconnectTimeoutRef — setTimeout that fires the next WS connection attempt.
 *   Cleared in the main effect's unmount return.
 *
 * How the reconnecting state is reached
 * ──────────────────────────────────────
 * The WS mock acks `join-viewer` with a `joined` message then immediately
 * closes the socket, mimicking a signaling-server drop.  watch.tsx's onclose
 * handler increments reconnectAttemptsRef, sets state to "reconnecting", and
 * schedules a retry after RECONNECT_DELAY_OVERRIDE_MS (set via query param to
 * 5 000 ms so the retry has NOT fired when we navigate away).
 *
 * How navigation is triggered
 * ───────────────────────────
 * wouter's router listens to `popstate`.  We call `history.pushState` then
 * dispatch a synthetic `popstate` event so wouter performs a SPA route change
 * (unmounting watch.tsx) without a full page reload.
 *
 * What is mocked vs exercised
 * ───────────────────────────
 * Mocked  : HTTP health-gate, live session status, ICE servers, WS server,
 *           RTCPeerConnection
 * Exercised: watch.tsx mount → WS drop → reconnecting timer start → unmount
 *            cleanup
 */

import { test, expect } from "@playwright/test";

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const CODE = "WMNT1";

// FakePeerConnection: keeps RTCPeerConnection calls from throwing in a
// browser context where a real STUN/TURN server isn't reachable.
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
          "v=0", "o=- 0 0 IN IP4 127.0.0.1", "s=-", "t=0 0",
          "a=group:BUNDLE 0",
          "m=video 9 UDP/TLS/RTP/SAVPF 96", "c=IN IP4 0.0.0.0",
          "a=mid:0", "a=recvonly", "a=rtcp-mux", "a=rtpmap:96 VP8/90000",
        ].join("\\r\\n") + "\\r\\n",
      };
    }
    async setLocalDescription(_desc) {}
    addIceCandidate() { return Promise.resolve(); }
    close() { this._closed = true; this.connectionState = "closed"; }
  }
  window.RTCPeerConnection = FakePeerConnection;
})();
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Watch page – no stale state updates after navigating away mid-reconnect", () => {
  test(
    "no React stale-update warnings fire after navigating away while reconnect timer is active",
    async ({ page }) => {
      // ── 0. Collect console warnings/errors ────────────────────────────────
      const consoleMessages: Array<{ type: string; text: string }> = [];
      page.on("console", (msg) => {
        const type = msg.type();
        if (type === "warning" || type === "error") {
          consoleMessages.push({ type, text: msg.text() });
        }
      });

      await page.addInitScript({ content: FAKE_PC_SCRIPT });

      // ── 1. Mock all API endpoints ──────────────────────────────────────────
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

      // ── 2. WS mock — close immediately after join-viewer ack ──────────────
      // This simulates a signaling-server drop and causes watch.tsx to enter
      // "reconnecting" state, starting the 1 s interval.
      // __watchReconnectDelayMs=5000 keeps the retry setTimeout pending for
      // 5 s so we can navigate away while both timers are still active.
      await page.routeWebSocket(
        (url) => url.pathname === "/api/live/ws",
        (ws) => {
          ws.onMessage((raw) => {
            let msg: Record<string, unknown>;
            try {
              msg = JSON.parse(
                typeof raw === "string" ? raw : new TextDecoder().decode(raw as unknown as ArrayBuffer)
              );
            } catch {
              return;
            }
            if (msg.type === "join-viewer") {
              // Ack the join so the component registers its viewerId, then
              // immediately close — this triggers ws.onclose in watch.tsx and
              // pushes the component into "reconnecting" state.
              ws.send(JSON.stringify({ type: "joined", viewerId: "test-viewer-wmnt" }));
              setTimeout(() => ws.close(), 50);
            }
          });
        }
      );

      // Navigate with a 5 s reconnect delay so the retry hasn't fired when
      // we navigate away, and a 60 s offer watchdog so it doesn't interfere.
      await page.goto(
        `/watch/${CODE}?__watchReconnectDelayMs=5000&__offerWatchdogMs=60000`
      );

      // ── 3. Wait for "Reconnecting…" to appear — proves the interval is running
      await expect(page.getByText(/Reconnecting…/)).toBeVisible({ timeout: 10_000 });

      // ── 4. Reset the message buffer so we only capture post-navigation noise ─
      consoleMessages.length = 0;

      // ── 5. Navigate away via a SPA route change (wouter listens to popstate) ─
      //       This unmounts watch.tsx without a full page reload.
      await page.evaluate(() => {
        window.history.pushState({}, "", "/");
        window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
      });

      // Brief pause to let React process the route change (unmount + cleanup).
      await page.waitForTimeout(100);

      // ── 6. Wait > 1 interval period so any leaked timer callback would fire ─
      //       The reconnect interval ticks every 1 000 ms; 1 500 ms is enough
      //       to catch two ticks if cleanup was missed.
      await page.waitForTimeout(1_500);

      // ── 7. Assert no stale-update warnings ────────────────────────────────
      const staleUpdateWarnings = consoleMessages.filter(
        ({ text }) =>
          text.includes("Can't perform a React state update on an unmounted component") ||
          // React 18 rephrased this warning in some builds.
          text.includes("Warning: Can't perform a React state update") ||
          text.includes("unmounted component")
      );

      expect(
        staleUpdateWarnings.map((m) => m.text),
        "Expected no React stale-state-update warnings after navigating away from watch page"
      ).toHaveLength(0);
    }
  );
});
