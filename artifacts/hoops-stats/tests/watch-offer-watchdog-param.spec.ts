/**
 * watch-offer-watchdog-param.spec.ts
 *
 * Confirms that the `__watchOfferS` URL parameter shortens the offer-arrival
 * watchdog interval so end-to-end tests don't need to wait a full 30 s.
 *
 * Scenario
 * ---------
 * 1. Viewer navigates to /watch/:code with `__watchOfferS=1`.
 * 2. WS opens and a `joined` ACK is sent — but deliberately no SDP offer,
 *    simulating a broadcaster that is absent.
 * 3. After ~1 s (first watchdog stage) the component increments the retry
 *    counter and sends `request-offer` over the still-open socket.
 *    The UI switches to "Retrying… (attempt N)" for some N ≥ 2.
 * 4. Still no offer arrives — after another ~1 s (second watchdog stage) the
 *    component transitions to `state="waiting-for-broadcaster"`.
 *    The UI shows the "Stream interrupted" waiting message.
 *
 * Why __watchOfferS=1
 * --------------------
 * Without the param the watchdog waits 30 s per stage (60 s total), which
 * is too slow for CI.  With __watchOfferS=1 each stage is 1 s, so the full
 * two-stage sequence completes in ~2 s of real time — well under the 10 s
 * Playwright action timeout.  The param is never present in production URLs
 * so it has no effect on live sessions.
 *
 * What is mocked vs what is exercised
 * -------------------------------------
 * Mocked  : HTTP health-gate, live session status, ICE server config, WS
 *           signaling server
 * Exercised: watch.tsx __watchOfferS param reading, two-stage offer-watchdog
 *            state machine, retry counter increment, `request-offer` dispatch,
 *            transition to "waiting-for-broadcaster" when broadcaster is absent
 */

import { test, expect } from "@playwright/test";

const CODE = "WOFR1";

test.describe("Watch page – __watchOfferS shortens the offer watchdog", () => {
  test(
    "retry counter increments and waiting-for-broadcaster shows within 5 s using __watchOfferS=1",
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
                  : new TextDecoder().decode(raw as ArrayBuffer)
              );
            } catch {
              return;
            }

            if (msg.type === "join-viewer") {
              // ACK the join — deliberately NO offer so the first-stage
              // watchdog fires and the retry counter increments.
              ws.send(JSON.stringify({ type: "joined", viewerId: "wofr-viewer-001" }));

            } else if (msg.type === "request-offer") {
              // Record it but do NOT reply — the second-stage watchdog must
              // fire and transition the component to "waiting-for-broadcaster".
              requestOfferMessages.push(msg as { type: string; code: string });
            }
          });
        }
      );

      // ── Navigate with __watchOfferS=1 ─────────────────────────────────────
      // Each watchdog stage is 1 s instead of 30 s; the full two-stage
      // sequence completes in ~2 s of real time.
      await page.goto(`/watch/${CODE}?__watchOfferS=1`);

      // ── 1. Component enters "connecting" state ─────────────────────────────
      await expect(
        page.getByText(/Joining the stream/)
      ).toBeVisible({ timeout: 10_000 });

      // ── 2. First-stage watchdog fires — retry counter increments ──────────
      // The component increments iceRetryCount and shows "Retrying… (attempt N)".
      // It also sends request-offer over the open WS.
      await expect(
        page.getByText(/Retrying…/)
      ).toBeVisible({ timeout: 5_000 });

      // "Joining the stream" must be replaced by the retry text.
      await expect(page.getByText(/Joining the stream/)).not.toBeVisible();

      // The component sent request-offer exactly once.
      await expect
        .poll(() => requestOfferMessages.length, { timeout: 3_000 })
        .toBe(1);

      expect(requestOfferMessages[0].type).toBe("request-offer");
      expect(requestOfferMessages[0].code).toBe(CODE);

      // ── 3. Second-stage watchdog fires → waiting-for-broadcaster ───────────
      // No offer arrived, so the component falls back gracefully instead of
      // looping or hanging on "connecting" forever.
      await expect(
        page.getByText(/Stream interrupted/)
      ).toBeVisible({ timeout: 5_000 });

      // Connecting overlay must be fully gone.
      await expect(page.getByText(/Retrying…/)).not.toBeVisible();

      // No additional request-offer messages were sent after the fallback.
      expect(requestOfferMessages).toHaveLength(1);
    }
  );
});
