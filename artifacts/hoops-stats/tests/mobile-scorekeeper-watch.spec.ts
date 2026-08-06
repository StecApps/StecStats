/**
 * mobile-scorekeeper-watch.spec.ts
 *
 * Confirms that a viewer watching a live game from a mobile score-keeper
 * (hasVideo: false) sees the score-only board — not a spinning "Connecting…"
 * state — and that the "Stream interrupted" banner clears automatically when
 * the mobile broadcaster reconnects within the grace period.
 *
 * Two scenarios:
 *
 * A – Viewer joins while mobile broadcaster is already running
 *     The server's `joined` message includes `hasVideo: false`.  The watch
 *     page must skip WebRTC negotiation and go straight to "live" score-only
 *     mode without waiting for an offer that will never arrive.
 *
 * B – Mobile broadcaster drops and reconnects within grace period
 *     While in score-only live state the server sends `broadcaster-reconnecting`
 *     (WS drop detected) followed by `broadcaster-reconnected` (rejoined within
 *     the 6 s grace window).  The viewer's "Coach signal reconnecting…" banner
 *     must appear on the first signal and disappear on the second — without the
 *     viewer tapping any button.
 *
 * What is mocked vs exercised
 * ---------------------------
 * Mocked  : HTTP health/status endpoints, WS signaling server
 * Exercised: watch.tsx `joined` hasVideo branch (→ immediate "live"),
 *            `broadcaster-reconnecting` banner, `broadcaster-reconnected` clear
 */

import { test, expect } from "@playwright/test";

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const CODE = "MBSK1";

// ---------------------------------------------------------------------------
// HTTP route helpers
// ---------------------------------------------------------------------------

async function setupHttpMocks(page: import("@playwright/test").Page) {
  // Health gate — lets the app past any API connectivity check.
  await page.route(
    (url) => url.pathname === "/api",
    (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );

  // Live session status — active, mobile broadcaster present.
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
          teamScore: 14,
          opponentScore: 9,
        }),
      }),
  );

  // ICE servers — not needed for score-only mode but the module imports it.
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
      }),
  );
}

// ---------------------------------------------------------------------------
// Test A — viewer joins while mobile broadcaster is already running
// ---------------------------------------------------------------------------

test.describe("Watch page – mobile score-keeper (hasVideo: false)", () => {
  test(
    "A – viewer goes live immediately in score-only mode when joined reports hasVideo: false",
    async ({ page }) => {
      await setupHttpMocks(page);

      // WS mock: reply to join-viewer with hasVideo: false and a scoreboard.
      // No offer is ever sent — the page must not wait for one.
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
              // Immediately ack with hasVideo: false so the component skips
              // WebRTC and goes straight to score-only "live" mode.
              ws.send(
                JSON.stringify({
                  type: "joined",
                  viewerId: "mob-viewer-001",
                  hasVideo: false,
                }),
              );
              ws.send(
                JSON.stringify({
                  type: "scoreboard",
                  teamScore: 14,
                  opponentScore: 9,
                }),
              );
            }
            // No offer is sent — proves the page doesn't need one.
          });
        },
      );

      // Use a short offer-watchdog override so the test doesn't rely on the
      // 30-second default to confirm that no watchdog fires.
      await page.goto(`/watch/${CODE}?__watchOfferS=2`);

      // ── 1. Component must NOT stay on "Joining the stream…" ──────────────
      // We only assert the live state arrived — not that "Joining" was never
      // shown, since it briefly appears during the WS handshake.

      // ── 2. Score-only live board must appear ──────────────────────────────
      // The "SCORE FEED" badge is the clearest score-only indicator.
      await expect(page.getByText("SCORE FEED")).toBeVisible({ timeout: 10_000 });

      // ── 3. Team scores must be displayed ─────────────────────────────────
      await expect(page.getByText("14")).toBeVisible({ timeout: 5_000 });
      await expect(page.getByText("9")).toBeVisible({ timeout: 5_000 });

      // ── 4. "Joining the stream…" spinner must not be present any more ─────
      await expect(page.getByText(/Joining the stream/i)).not.toBeVisible();

      // ── 5. "Tap for sound" mute overlay must NOT be present (score-only) ──
      await expect(page.getByText(/Tap for sound/i)).not.toBeVisible();

      // ── 6. Share button must be visible (live state bottom controls) ──────
      await expect(page.getByRole("button", { name: /Share/i })).toBeVisible({ timeout: 5_000 });
    },
  );
});

// ---------------------------------------------------------------------------
// Test B — "Stream interrupted" banner clears on broadcaster-reconnected
// ---------------------------------------------------------------------------

test.describe("Watch page – mobile broadcaster drop + reconnect within grace period", () => {
  test(
    "B – reconnecting banner clears automatically when broadcaster-reconnected arrives",
    async ({ page }) => {
      await setupHttpMocks(page);

      // WS mock: three-phase sequence.
      //   Phase 1 (join-viewer): score-only live state established.
      //   Phase 2 (triggered via close or message): server sends broadcaster-reconnecting.
      //   Phase 3: server sends broadcaster-reconnected after a short delay.
      //
      // We hold a reference to the WS so we can push the phase-2/3 messages
      // after the viewer is confirmed live.
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

            if (msg.type === "join-viewer") {
              // Phase 1: acknowledge with hasVideo: false + scoreboard.
              ws.send(
                JSON.stringify({
                  type: "joined",
                  viewerId: "mob-viewer-002",
                  hasVideo: false,
                }),
              );
              ws.send(
                JSON.stringify({
                  type: "scoreboard",
                  teamScore: 14,
                  opponentScore: 9,
                }),
              );
            }
            // Ignore request-offer and other viewer-side messages.
          });
        },
      );

      await page.goto(`/watch/${CODE}?__watchOfferS=2`);

      // ── 1. Reach score-only live state ────────────────────────────────────
      await expect(page.getByText("SCORE FEED")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText("14")).toBeVisible({ timeout: 5_000 });

      // Confirm the banner is NOT shown at rest.
      await expect(
        page.getByText(/Coach signal reconnecting/i),
      ).not.toBeVisible();

      // ── 2. Server signals that the broadcaster's WS dropped ────────────────
      // This simulates what liveSocket.ts does when the mobile coach's WS
      // closes: it fans `broadcaster-reconnecting` to all viewers before
      // starting the 6-second grace-period timer.
      expect(serverWs).not.toBeNull();
      serverWs!.send(
        JSON.stringify({ type: "broadcaster-reconnecting" }),
      );

      // ── 3. Banner must appear ─────────────────────────────────────────────
      await expect(
        page.getByText(/Coach signal reconnecting/i),
      ).toBeVisible({ timeout: 5_000 });

      // Score board must still be visible — the viewer stays in "live" state.
      await expect(page.getByText("SCORE FEED")).toBeVisible();

      // ── 4. Server signals broadcaster rejoined within grace period ─────────
      // liveSocket.ts sends `broadcaster-reconnected` when join-broadcaster
      // arrives during the grace window AND hasVideo is false (no offer will
      // clear the banner for a mobile broadcaster).
      serverWs!.send(
        JSON.stringify({ type: "broadcaster-reconnected" }),
      );

      // ── 5. Banner must clear automatically — no user action required ───────
      await expect(
        page.getByText(/Coach signal reconnecting/i),
      ).not.toBeVisible({ timeout: 5_000 });

      // Score board must remain, confirming the stream is still in "live" state.
      await expect(page.getByText("SCORE FEED")).toBeVisible({ timeout: 5_000 });
      await expect(page.getByText("14")).toBeVisible();
    },
  );
});
