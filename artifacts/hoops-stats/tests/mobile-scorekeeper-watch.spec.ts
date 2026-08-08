/**
 * mobile-scorekeeper-watch.spec.ts
 *
 * Confirms that a viewer watching a live game from a mobile score-keeper
 * (hasVideo: false / videoMode: 'none') sees the score-only board — not a
 * spinning "Connecting…" state — and that the "Stream interrupted" banner
 * clears automatically when the mobile broadcaster reconnects within the grace
 * period.
 *
 * Six scenarios:
 *
 * A – Viewer joins while mobile broadcaster is already running
 *     The server's `joined` message includes `hasVideo: false` + `videoMode:
 *     'none'` (matching what scorekeeper.tsx sends when camera permission is
 *     denied).  The watch page must skip WebRTC negotiation and go straight to
 *     "live" score-only mode without waiting for an offer that will never arrive.
 *
 * B – Mobile broadcaster drops and reconnects within grace period
 *     While in score-only live state the server sends `broadcaster-reconnecting`
 *     (WS drop detected) followed by `broadcaster-reconnected` (rejoined within
 *     the 6 s grace window).  The viewer's "Coach signal reconnecting…" banner
 *     must appear on the first signal and disappear on the second — without the
 *     viewer tapping any button.
 *
 * C – Score-only mode arrives before the offer watchdog fires (camera denied)
 *     This is the regression guard for the specific bug: when camera permission
 *     is denied on the coach's phone the broadcaster sends videoMode: 'none'.
 *     If the watch page relied solely on the offer-watchdog timeout to enter
 *     score-only mode, the viewer would be stuck on "Connecting…" for up to
 *     6 s (the default watchdog).  The test compresses the watchdog to 1 s
 *     and asserts SCORE FEED appears within 800 ms — well before the watchdog
 *     would fire — proving the page uses the `hasVideo: false` signal directly,
 *     not the watchdog fallback.  A follow-up scoreboard update verifies live
 *     score propagation continues to work.
 *
 * D – Score-only board survives a brief viewer-side WS blip
 *     After score-only live state is established the viewer's signaling WS
 *     closes (network drop).  The page reconnects, the server sends a new
 *     `joined { hasVideo: false }`, and SCORE FEED must reappear without the
 *     viewer seeing a frozen or stuck state.  The test deliberately delays the
 *     reconnect getLiveStatus response so it resolves AFTER the joined message,
 *     confirming the race-condition guard in watch.tsx's connect(true) path.
 *
 * E – Late-joining viewer also sees score-only board instantly
 *     The broadcaster has already joined with videoMode: 'none' (camera denied)
 *     before this second viewer connects.  The server should echo the session's
 *     stored broadcasterHasVideo: false / broadcasterVideoMode: 'none' in the
 *     `joined` response so the late joiner goes straight to score-only mode
 *     without spinning.  SCORE FEED must appear within 800 ms — identical to
 *     the first viewer's experience — confirming the watch page doesn't need an
 *     offer to enter live mode regardless of when it connects.
 *
 * What is mocked vs exercised
 * ---------------------------
 * Mocked  : HTTP health/status endpoints, WS signaling server
 * Exercised: watch.tsx `joined` hasVideo branch (→ immediate "live"),
 *            `broadcaster-reconnecting` banner, `broadcaster-reconnected` clear,
 *            offer-watchdog cancellation on score-only join,
 *            viewer-side WS reconnect path (connect(true) getLiveStatus race),
 *            late-joiner path (server already has broadcasterHasVideo: false)
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
              // Immediately ack with hasVideo: false + videoMode: 'none' —
              // matching what the server sends when the mobile broadcaster's
              // camera permission is denied.
              ws.send(
                JSON.stringify({
                  type: "joined",
                  viewerId: "mob-viewer-001",
                  hasVideo: false,
                  videoMode: "none",
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

// ---------------------------------------------------------------------------
// Test C — score-only arrives before the offer watchdog fires (camera denied)
// ---------------------------------------------------------------------------

test.describe("Watch page – camera permission denied → immediate score-only, no watchdog wait", () => {
  test(
    "C – SCORE FEED visible within 800 ms when videoMode: none is received, proving no watchdog wait",
    async ({ page }) => {
      await setupHttpMocks(page);

      // Hold a ref to push server-side messages after the initial handshake.
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
              // Simulate the exact payload liveSocket.ts sends when the mobile
              // broadcaster joined with hasVideo: false (camera permission denied).
              // videoMode: 'none' matches what scorekeeper.tsx sends.
              ws.send(
                JSON.stringify({
                  type: "joined",
                  viewerId: "mob-viewer-cam-denied",
                  hasVideo: false,
                  videoMode: "none",
                }),
              );
              ws.send(
                JSON.stringify({
                  type: "scoreboard",
                  teamScore: 21,
                  opponentScore: 14,
                }),
              );
            }
            // No offer is ever sent — the page must not wait for one.
          });
        },
      );

      // Compress the offer watchdog to 1 s.  If the component relied on the
      // watchdog to enter score-only mode, SCORE FEED would never appear within
      // 800 ms (the watchdog hasn't fired yet) — the assertion below would fail.
      await page.goto(`/watch/${CODE}?__watchOfferS=1`);

      // ── 1. SCORE FEED must appear before the 1-second watchdog fires ──────
      // 800 ms deadline proves the page acted on `hasVideo: false` directly,
      // not on the offer-watchdog fallback path.
      await expect(page.getByText("SCORE FEED")).toBeVisible({ timeout: 800 });

      // ── 2. Scores from the initial scoreboard message must be visible ──────
      await expect(page.getByText("21")).toBeVisible({ timeout: 2_000 });
      await expect(page.getByText("14")).toBeVisible({ timeout: 2_000 });

      // ── 3. "Joining the stream…" spinner must be gone ─────────────────────
      await expect(page.getByText(/Joining the stream/i)).not.toBeVisible();

      // ── 4. No "Tap for sound" overlay (score-only has no audio track) ──────
      await expect(page.getByText(/Tap for sound/i)).not.toBeVisible();

      // ── 5. Live score updates propagate in real time ──────────────────────
      // Push a new scoreboard message from the server and verify it renders.
      expect(serverWs).not.toBeNull();
      serverWs!.send(
        JSON.stringify({ type: "scoreboard", teamScore: 23, opponentScore: 14 }),
      );
      await expect(page.getByText("23")).toBeVisible({ timeout: 3_000 });

      // ── 6. Share button visible (live-state controls present) ─────────────
      await expect(
        page.getByRole("button", { name: /Share/i }),
      ).toBeVisible({ timeout: 3_000 });
    },
  );
});

// ---------------------------------------------------------------------------
// Test D — score-only board survives a brief viewer-side WS blip
// ---------------------------------------------------------------------------

test.describe("Watch page – score-only survives viewer WS reconnect", () => {
  test(
    "D – SCORE FEED reappears after viewer WS drops and reconnects (no offer sent or awaited)",
    async ({ page }) => {
      // ── Status route: first call (initial load) responds immediately;
      //    second call (inside connect(true)) is delayed 500 ms so that the
      //    reconnect `joined { hasVideo: false }` message always arrives first.
      //    This deliberately surfaces the getLiveStatus race — without the
      //    guard in watch.tsx the delayed setState("connecting") would clobber
      //    the "live" state and hide SCORE FEED from the viewer.
      let statusCallCount = 0;
      await page.route(
        (url) => url.pathname === `/api/live/${CODE}/status`,
        async (route) => {
          statusCallCount++;
          if (statusCallCount > 1) {
            // Reconnect call — delay long enough for the WS joined message to
            // be processed first (500 ms >> typical WS round-trip < 50 ms).
            await new Promise<void>((r) => setTimeout(r, 500));
          }
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              active: true,
              opponent: "Visitors",
              teamName: "Home",
              viewerCount: 1,
              teamScore: 18,
              opponentScore: 12,
            }),
          });
        },
      );

      // HTTP mocks for health gate and ICE servers.
      await page.route(
        (url) => url.pathname === "/api",
        (route) =>
          route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
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
          }),
      );

      // Track how many WS connections have been established.
      // Connection 0 = initial join; connection ≥ 1 = after the blip.
      let connectionIndex = 0;
      // Hold a reference to the first connection so we can close it.
      let firstServerWs: import("@playwright/test").WebSocketRoute | null = null;
      // Resolved once the reconnect connection's join-viewer is received —
      // this proves a second WS was actually opened and the server saw it.
      let signalSecondJoinReceived!: () => void;
      const secondJoinReceived = new Promise<void>(
        (resolve) => { signalSecondJoinReceived = resolve; },
      );
      // Track whether any connection requested a WebRTC offer —
      // must never happen for a score-only session.
      let offerRequested = false;

      await page.routeWebSocket(
        (url) => url.pathname === "/api/live/ws",
        (ws) => {
          const idx = connectionIndex++;

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

            if (msg.type === "request-offer") {
              offerRequested = true;
              return;
            }

            if (msg.type === "join-viewer") {
              if (idx === 0) {
                // ── First connection: score-only joined + initial scoreboard ──
                firstServerWs = ws;
                ws.send(
                  JSON.stringify({
                    type: "joined",
                    viewerId: "blip-viewer-001",
                    hasVideo: false,
                    videoMode: "none",
                  }),
                );
                ws.send(
                  JSON.stringify({ type: "scoreboard", teamScore: 18, opponentScore: 12 }),
                );
              } else {
                // ── Reconnect connection ──────────────────────────────────────
                // Signal the test that a second WS join was received, then
                // immediately send the score-only joined reply.  The 500 ms
                // delayed status response will resolve *after* this message,
                // so the test asserts that the late status doesn't clobber
                // the "live" state already set by this joined handler.
                signalSecondJoinReceived();
                ws.send(
                  JSON.stringify({
                    type: "joined",
                    viewerId: "blip-viewer-001",
                    hasVideo: false,
                    videoMode: "none",
                  }),
                );
                ws.send(
                  JSON.stringify({ type: "scoreboard", teamScore: 18, opponentScore: 12 }),
                );
              }
            }
          });
        },
      );

      // __watchReconnectDelayMs=0 — reconnect fires immediately after WS close
      // __watchOfferS=2           — short offer watchdog (must not be needed)
      await page.goto(`/watch/${CODE}?__watchReconnectDelayMs=0&__watchOfferS=2`);

      // ── 1. Reach score-only live state on the first WS connection ──────────
      await expect(page.getByText("SCORE FEED")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText("18")).toBeVisible({ timeout: 5_000 });
      await expect(page.getByText("12")).toBeVisible({ timeout: 5_000 });

      // ── 2. Simulate a brief viewer-side network blip by closing the WS ─────
      // Playwright's close() on the server-side route triggers ws.onclose in
      // the page, exactly as a real network drop would.
      expect(firstServerWs).not.toBeNull();
      firstServerWs!.close();

      // ── 3. Gate on the second WS join actually being received ──────────────
      // This proves a new WebSocket was opened and the server saw join-viewer —
      // not that we're merely asserting on the first connection's cached state.
      await secondJoinReceived;

      // ── 4. Allow the delayed getLiveStatus response (500 ms) to settle ──────
      // If the guard in watch.tsx is absent the late setState("connecting")
      // overwrites "live" and SCORE FEED disappears here.
      // 700 ms > 500 ms delay + React render cycle.
      await page.waitForTimeout(700);

      // ── 5. SCORE FEED must still be visible after the late status settles ───
      // This is the key regression guard: the delayed status response must NOT
      // clobber the "live" state set by the reconnect joined handler.
      await expect(page.getByText("SCORE FEED")).toBeVisible({ timeout: 3_000 });
      await expect(page.getByText("18")).toBeVisible({ timeout: 3_000 });
      await expect(page.getByText("12")).toBeVisible({ timeout: 3_000 });

      // ── 6. No WebRTC offer was requested during the entire lifecycle ────────
      expect(offerRequested).toBe(false);

      // ── 7. "Joining the stream…" spinner must not linger ──────────────────
      await expect(page.getByText(/Joining the stream/i)).not.toBeVisible();

      // ── 8. Share button visible (live-state controls present) ─────────────
      await expect(
        page.getByRole("button", { name: /Share/i }),
      ).toBeVisible({ timeout: 3_000 });
    },
  );
});

// ---------------------------------------------------------------------------
// Test E — late-joining viewer also sees score-only board instantly
// ---------------------------------------------------------------------------

test.describe("Watch page – late-joining viewer sees score-only instantly (broadcaster already no-video)", () => {
  test(
    "E – SCORE FEED visible within 800 ms for a viewer who joins after the broadcaster already set videoMode: none",
    async ({ page }) => {
      await setupHttpMocks(page);

      // WS mock: the broadcaster has already joined with videoMode: 'none'
      // (camera permission was denied at go-live).  The in-memory session on
      // the server therefore has broadcasterHasVideo: false and
      // broadcasterVideoMode: 'none'.  When this late-joining viewer sends
      // join-viewer, liveSocket.ts reads those fields from the existing session
      // and echoes them back in the `joined` response — which is what we
      // simulate here.  No offer is ever sent (the broadcaster has no video).
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
              // Server already has broadcasterHasVideo: false from the
              // broadcaster's earlier join-broadcaster with videoMode: 'none'.
              // liveSocket.ts line 179:
              //   safeSend(ws, { type: "joined", viewerId, hasVideo: session.broadcasterHasVideo, videoMode: session.broadcasterVideoMode });
              ws.send(
                JSON.stringify({
                  type: "joined",
                  viewerId: "late-viewer-001",
                  hasVideo: false,
                  videoMode: "none",
                }),
              );
              // Include a current scoreboard — the session has been running,
              // scores have accumulated.
              ws.send(
                JSON.stringify({
                  type: "scoreboard",
                  teamScore: 31,
                  opponentScore: 18,
                }),
              );
            }
            // No WebRTC offer is ever sent — proves the page doesn't need one.
          });
        },
      );

      // Compress the offer watchdog to 1 s — if the page relied on it to enter
      // score-only mode, SCORE FEED would not appear within 800 ms.
      await page.goto(`/watch/${CODE}?__watchOfferS=1`);

      // ── 1. SCORE FEED must appear before the 1-second watchdog fires ──────
      // 800 ms deadline proves the watch page acted on `hasVideo: false` in the
      // `joined` message directly, not on the offer-watchdog fallback path.
      await expect(page.getByText("SCORE FEED")).toBeVisible({ timeout: 800 });

      // ── 2. Accumulated scores must be visible immediately ─────────────────
      await expect(page.getByText("31")).toBeVisible({ timeout: 2_000 });
      await expect(page.getByText("18")).toBeVisible({ timeout: 2_000 });

      // ── 3. "Joining the stream…" spinner must be gone ─────────────────────
      await expect(page.getByText(/Joining the stream/i)).not.toBeVisible();

      // ── 4. No "Tap for sound" overlay (score-only has no audio track) ──────
      await expect(page.getByText(/Tap for sound/i)).not.toBeVisible();

      // ── 5. Live score updates still propagate after late join ─────────────
      // Push a new scoreboard from the server — proves the WS channel is
      // fully functional for the late joiner, not just the initial render.
      expect(serverWs).not.toBeNull();
      serverWs!.send(
        JSON.stringify({ type: "scoreboard", teamScore: 33, opponentScore: 18 }),
      );
      await expect(page.getByText("33")).toBeVisible({ timeout: 3_000 });

      // ── 6. Share button visible (live-state controls present) ─────────────
      await expect(
        page.getByRole("button", { name: /Share/i }),
      ).toBeVisible({ timeout: 3_000 });
    },
  );
});
