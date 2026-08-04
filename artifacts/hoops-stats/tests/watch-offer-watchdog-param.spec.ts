/**
 * watch-offer-watchdog-param.spec.ts
 *
 * Confirms that the offer-arrival watchdog respects MAX_WATCH_RECONNECT_ATTEMPTS
 * and that the `__watchOfferS` URL parameter shortens the interval so CI doesn't
 * need to wait the full 30 s per stage.
 *
 * Scenario
 * ---------
 * 1. Viewer navigates to /watch/:code with `__watchOfferS=1`.
 * 2. WS opens and a `joined` ACK is sent — but deliberately no SDP offer,
 *    simulating a broadcaster that is permanently absent.
 * 3. The watchdog fires up to MAX_WATCH_RECONNECT_ATTEMPTS (6) times.
 *    On each of the first 5 firings the component increments the retry counter
 *    and sends `request-offer` over the still-open socket.
 * 4. On the 6th firing the cap is reached (attempts >= MAX_WATCH_RECONNECT_ATTEMPTS)
 *    and the component transitions to `state="ended"` showing
 *    "Connection dropped and couldn't be restored."
 * 5. No further `request-offer` messages are sent after that point.
 *
 * Why __watchOfferS=1
 * --------------------
 * Without the param the watchdog waits 30 s per firing (180 s total for 6
 * rounds), which is too slow for CI.  With __watchOfferS=1 each firing takes
 * 1 s, so the full sequence completes in ~6 s of real time — well within the
 * Playwright default timeout.  The param is never present in production URLs
 * so it has no effect on live sessions.
 *
 * What is mocked vs what is exercised
 * -------------------------------------
 * Mocked  : HTTP health-gate, live session status, ICE server config, WS
 *           signaling server
 * Exercised: watch.tsx __watchOfferS param reading, capped offer-watchdog
 *            state machine (MAX_WATCH_RECONNECT_ATTEMPTS), retry counter
 *            increment, `request-offer` dispatch, transition to "ended" when
 *            broadcaster never responds
 */

import { test, expect } from "@playwright/test";

const CODE = "WOFR1";
const MAX_WATCH_RECONNECT_ATTEMPTS = 6;

test.describe("Watch page – offer watchdog caps at MAX_WATCH_RECONNECT_ATTEMPTS", () => {
  test(
    "sends request-offer up to cap then shows 'Connection dropped' — not a spinner",
    async ({ page }) => {

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
                  : new TextDecoder().decode(raw as unknown as ArrayBuffer)
              );
            } catch {
              return;
            }

            if (msg.type === "join-viewer") {
              // ACK the join — deliberately NO offer so the watchdog fires.
              ws.send(JSON.stringify({ type: "joined", viewerId: "wofr-viewer-001" }));

            } else if (msg.type === "request-offer") {
              // Record it but do NOT reply — watchdog must keep firing until cap.
              requestOfferMessages.push(msg as { type: string; code: string });
            }
          });
        }
      );

      // ── Navigate with __watchOfferS=1 ─────────────────────────────────────
      // Each watchdog firing is 1 s; all MAX_WATCH_RECONNECT_ATTEMPTS firings
      // complete in ~6 s of real time.
      await page.goto(`/watch/${CODE}?__watchOfferS=1`);

      // ── 1. Component enters "connecting" state ─────────────────────────────
      await expect(
        page.getByText(/Joining the stream/)
      ).toBeVisible({ timeout: 10_000 });

      // ── 2. Watchdog cycles through all attempts ────────────────────────────
      // Each firing (except the last) sends request-offer and re-arms.
      // The last firing (attempt = MAX_WATCH_RECONNECT_ATTEMPTS) transitions
      // to "ended" without sending another request-offer.
      // Expected count: MAX_WATCH_RECONNECT_ATTEMPTS - 1 = 5 messages.
      await expect
        .poll(() => requestOfferMessages.length, { timeout: 12_000, intervals: [500] })
        .toBe(MAX_WATCH_RECONNECT_ATTEMPTS - 1);

      // ── 3. Final watchdog firing → "ended" ────────────────────────────────
      // The component must show the dropped-connection message instead of
      // staying on a spinner or showing "Stream interrupted" / waiting-for-broadcaster.
      await expect(
        page.getByText(/Connection dropped and couldn't be restored/)
      ).toBeVisible({ timeout: 5_000 });

      // Connecting overlay must be fully gone.
      await expect(page.getByText(/Joining the stream/)).not.toBeVisible();
      await expect(page.getByText(/Retrying…/)).not.toBeVisible();
      await expect(page.getByText(/Stream interrupted/)).not.toBeVisible();

      // ── 4. No extra request-offer messages after the cap ───────────────────
      // Wait an extra 1.5 watchdog cycles to confirm no further messages arrive.
      await page.waitForTimeout(1_500);
      expect(requestOfferMessages).toHaveLength(MAX_WATCH_RECONNECT_ATTEMPTS - 1);

      // All messages targeted the correct session code.
      for (const msg of requestOfferMessages) {
        expect(msg.type).toBe("request-offer");
        expect(msg.code).toBe(CODE);
      }
    }
  );
});
