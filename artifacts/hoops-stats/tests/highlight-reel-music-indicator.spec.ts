/**
 * Task #194 — Confirm the 'Generated with' indicator survives a hard refresh
 * on a game with an existing reel.
 *
 * The GET /api/games/:id/highlight (and /lowlight) endpoint returns the
 * `musicTrack` field of the stored reel. The record page seeds
 * `highlightLastUsedTrack` / `lowlightLastUsedTrack` from that field on mount.
 * This test verifies the badge shows the correct track name after a hard
 * refresh — including when localStorage has been cleared so the page must
 * rely entirely on the server response.
 *
 * Strategy
 * ────────
 * 1. Create a real Clerk user + team + game via API.
 * 2. Mock the highlight / lowlight GET endpoints to return a "ready" reel
 *    with a known musicTrack, and mock the game endpoint to include a
 *    videoObjectPath (required for the reel section to render).
 * 3. Navigate to /record/:gameId, assert the badge.
 * 4. Clear both localStorage keys that normally cache the track, then reload
 *    the page — only the server response can now hydrate the state.
 * 5. Assert the badge still shows the correct track name.
 * 6. Repeat steps 3-5 for the lowlight reel.
 *
 * NOTE: This spec uses Playwright's route interception rather than a real
 * ffmpeg reel generation. The server-persistence of musicTrack (column write
 * on POST, column read on GET) is exercised by the API-server unit tests;
 * this spec exercises the frontend end-to-end path: server response →
 * React state → visible badge → hard-refresh → badge still correct.
 */

import { test, expect } from "@playwright/test";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

// ---------------------------------------------------------------------------
// Clerk user lifecycle helpers
// ---------------------------------------------------------------------------

const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY ?? "";
const API_BASE = process.env.REPLIT_DEV_DOMAIN
  ? `https://${process.env.REPLIT_DEV_DOMAIN}/api`
  : `http://localhost:${process.env.PORT ?? 5173}/api`;

interface ClerkUser {
  id: string;
}

async function createClerkUser(email: string, password: string): Promise<ClerkUser> {
  const res = await fetch("https://api.clerk.com/v1/users", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CLERK_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email_address: [email],
      password,
      skip_password_checks: true,
      skip_password_requirement: true,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to create Clerk user: ${res.status} ${body}`);
  }
  return res.json() as Promise<ClerkUser>;
}

async function deleteClerkUser(id: string): Promise<void> {
  await fetch(`https://api.clerk.com/v1/users/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${CLERK_SECRET_KEY}` },
  });
}

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test-music-indicator.example.com`;
}

// ---------------------------------------------------------------------------
// Constants shared with the app
// ---------------------------------------------------------------------------

const HIGHLIGHT_LAST_USED_KEY = "stec:highlight-last-used-music-track";
const LOWLIGHT_LAST_USED_KEY  = "stec:lowlight-last-used-music-track";

// Fake GCS path returned by the stubbed GET responses.
const FAKE_HIGHLIGHT_PATH = "objects/fake-game-highlight.mp4";
const FAKE_LOWLIGHT_PATH  = "objects/fake-game-lowlight.mp4";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Generated-with music indicator – survives hard refresh", () => {
  let userId = "";
  let gameId = 0;

  const email    = uniqueEmail("music-indicator");
  const password = "MusicTest!9x";

  test.beforeAll(async () => {
    const user = await createClerkUser(email, password);
    userId = user.id;
  });

  test.afterAll(async () => {
    if (userId) await deleteClerkUser(userId);
  });

  // ── shared setup: create a real team + game so the URL is authentic ────────
  async function seedGame(page: Parameters<Parameters<typeof test>[1]>[0]): Promise<number> {
    // If already created by a previous test in the suite, reuse it.
    if (gameId > 0) return gameId;

    const cookies = await page.context().cookies();
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

    const teamRes = await page.request.post(`${API_BASE}/teams`, {
      data: { name: "Music Test Team", sport: "basketball" },
      headers: { "Content-Type": "application/json", Cookie: cookieHeader },
    });
    if (!teamRes.ok()) throw new Error(`POST /teams → ${teamRes.status()}: ${await teamRes.text()}`);
    const team = (await teamRes.json()) as { id: number };

    const playerRes = await page.request.post(`${API_BASE}/players`, {
      data: { name: "Music Test Player", teamId: team.id },
      headers: { "Content-Type": "application/json", Cookie: cookieHeader },
    });
    if (!playerRes.ok()) throw new Error(`POST /players → ${playerRes.status()}: ${await playerRes.text()}`);
    const player = (await playerRes.json()) as { id: number };

    const gameRes = await page.request.post(`${API_BASE}/games`, {
      data: {
        teamId: team.id,
        opponent: "Badge Check FC",
        date: "2026-01-15",
        result: "W",
        teamScore: 95,
        opponentScore: 80,
        stats: [{
          playerId: player.id,
          twoMade: 4, twoAttempted: 6,
          threeMade: 2, threeAttempted: 3,
          ftMade: 1, ftAttempted: 1,
          assists: 3, rebounds: 5,
          steals: 1, turnovers: 1, blocks: 0,
        }],
        events: [],
      },
      headers: { "Content-Type": "application/json", Cookie: cookieHeader },
    });
    if (!gameRes.ok()) throw new Error(`POST /games → ${gameRes.status()}: ${await gameRes.text()}`);
    const game = (await gameRes.json()) as { id: number };
    gameId = game.id;
    return gameId;
  }

  // ── helper: install route stubs so the page renders the reel section ───────
  async function installRouteStubs(
    page: Parameters<Parameters<typeof test>[1]>[0],
    gId: number,
    opts: {
      highlightMusicTrack: string;
      lowlightMusicTrack: string;
    },
  ): Promise<void> {
    // Billing: pro so the Highlight + Lowlight sections are both rendered.
    await page.route("**/api/billing/status", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ plan: "pro", active: true }),
      }),
    );

    // Minimal players / teams to pass the OnboardingGate.
    await page.route("**/api/players", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{ id: 1, name: "Music Test Player", teamId: 1 }]),
      }),
    );
    await page.route("**/api/teams", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{ id: 1, name: "Music Test Team", sport: "basketball" }]),
      }),
    );

    // TURN / ICE (prevent real network calls).
    await page.route("**/api/live/ice-servers", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
          turnAvailable: false,
        }),
      }),
    );

    // The game itself — videoObjectPath must be non-null so the reel section
    // renders (`isEditing && existingVideoObjectPath && !recordedPreviewUrl`).
    await page.route(`**/api/games/${gId}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: gId,
          teamId: 1,
          opponent: "Badge Check FC",
          date: "2026-01-15",
          result: "W",
          teamScore: 95,
          opponentScore: 80,
          videoObjectPath: "objects/fake-game-video.mp4",
          videoDurationMs: 3600000,
          stats: [],
          events: [],
          highlights: [],
        }),
      }),
    );

    // Highlight: "ready" with the track we want to verify.
    await page.route(`**/api/games/${gId}/highlight`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "ready",
          highlightObjectPath: FAKE_HIGHLIGHT_PATH,
          error: null,
          startedAt: "2026-01-15T20:00:00.000Z",
          eligibleMoments: 6,
          onFilmMoments: 6,
          musicTrack: opts.highlightMusicTrack,
        }),
      }),
    );

    // Lowlight: "ready" with a different track to distinguish the two badges.
    await page.route(`**/api/games/${gId}/lowlight`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "ready",
          lowlightObjectPath: FAKE_LOWLIGHT_PATH,
          error: null,
          startedAt: "2026-01-15T20:10:00.000Z",
          eligibleMoments: 4,
          onFilmMoments: 4,
          musicTrack: opts.lowlightMusicTrack,
        }),
      }),
    );

    // Video object endpoint — return an empty 200 so the <video> src doesn't
    // produce a network error that could mask the badge in the DOM.
    await page.route("**/api/storage/objects/**", (route) =>
      route.fulfill({ status: 200, body: "" }),
    );
  }

  // ── test 1: highlight indicator ────────────────────────────────────────────
  test(
    "highlight 'Generated with' badge shows correct track after hard refresh",
    async ({ page }) => {
      await setupClerkTestingToken({ page, userId });

      // Navigate to dashboard first so Clerk auth cookies are established.
      await page.goto("/dashboard");
      await page.waitForURL(/\/dashboard/, { timeout: 15_000 });

      const gId = await seedGame(page);

      await installRouteStubs(page, gId, {
        highlightMusicTrack: "energetic",
        lowlightMusicTrack: "lofi",
      });

      // ── First load ──────────────────────────────────────────────────────
      await page.goto(`/record/${gId}`);

      // Wait for the highlight section to render.
      await expect(page.getByText("Highlight Reel")).toBeVisible({ timeout: 15_000 });

      // The badge must show the track name from the server response.
      const highlightBadge = page
        .locator("p.text-xs")
        .filter({ hasText: /Generated with:/i })
        .first();

      await expect(highlightBadge).toContainText("Energetic", { timeout: 10_000 });

      // ── Simulate hard refresh: clear localStorage caches so the page
      //    must re-hydrate purely from the server response. ──────────────
      await page.evaluate((key) => {
        localStorage.removeItem(key);
      }, HIGHLIGHT_LAST_USED_KEY);

      // Re-install route stubs (route handlers don't survive page.reload).
      await installRouteStubs(page, gId, {
        highlightMusicTrack: "energetic",
        lowlightMusicTrack: "lofi",
      });

      await page.reload();

      // Wait for the section to re-appear after reload.
      await expect(page.getByText("Highlight Reel")).toBeVisible({ timeout: 15_000 });

      // Badge must still show the correct track — relying only on the server.
      await expect(highlightBadge).toContainText("Energetic", { timeout: 10_000 });

      // And it must NOT fall back to "No music".
      await expect(highlightBadge).not.toContainText("No music");
    },
  );

  // ── test 2: lowlight indicator ─────────────────────────────────────────────
  test(
    "lowlight 'Generated with' badge shows correct track after hard refresh",
    async ({ page }) => {
      await setupClerkTestingToken({ page, userId });

      await page.goto("/dashboard");
      await page.waitForURL(/\/dashboard/, { timeout: 15_000 });

      const gId = await seedGame(page);

      await installRouteStubs(page, gId, {
        highlightMusicTrack: "energetic",
        lowlightMusicTrack: "oldschool",
      });

      // ── First load ──────────────────────────────────────────────────────
      await page.goto(`/record/${gId}`);

      await expect(page.getByText("Lowlight Reel")).toBeVisible({ timeout: 15_000 });

      // There are two "Generated with:" paragraphs on this page (one for each
      // reel type).  The lowlight one is the second occurrence.
      const lowlightBadge = page
        .locator("p.text-xs")
        .filter({ hasText: /Generated with:/i })
        .nth(1);

      await expect(lowlightBadge).toContainText("Old School", { timeout: 10_000 });

      // ── Simulate hard refresh ──────────────────────────────────────────
      await page.evaluate((key) => {
        localStorage.removeItem(key);
      }, LOWLIGHT_LAST_USED_KEY);

      await installRouteStubs(page, gId, {
        highlightMusicTrack: "energetic",
        lowlightMusicTrack: "oldschool",
      });

      await page.reload();

      await expect(page.getByText("Lowlight Reel")).toBeVisible({ timeout: 15_000 });

      await expect(lowlightBadge).toContainText("Old School", { timeout: 10_000 });
      await expect(lowlightBadge).not.toContainText("No music");
    },
  );

  // ── test 3: badge shows "No music" when reel was generated without a track ─
  test(
    "badge shows 'No music' after hard refresh when reel had no music track",
    async ({ page }) => {
      await setupClerkTestingToken({ page, userId });

      await page.goto("/dashboard");
      await page.waitForURL(/\/dashboard/, { timeout: 15_000 });

      const gId = await seedGame(page);

      // Stub both reels with musicTrack: null — server returns no track.
      await page.route("**/api/billing/status", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ plan: "pro", active: true }),
        }),
      );
      await page.route("**/api/players", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([{ id: 1, name: "Music Test Player", teamId: 1 }]),
        }),
      );
      await page.route("**/api/teams", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([{ id: 1, name: "Music Test Team", sport: "basketball" }]),
        }),
      );
      await page.route("**/api/live/ice-servers", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }], turnAvailable: false }),
        }),
      );
      await page.route(`**/api/games/${gId}`, (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            id: gId,
            teamId: 1,
            opponent: "Badge Check FC",
            date: "2026-01-15",
            result: "W",
            teamScore: 95,
            opponentScore: 80,
            videoObjectPath: "objects/fake-game-video.mp4",
            videoDurationMs: 3600000,
            stats: [],
            events: [],
            highlights: [],
          }),
        }),
      );
      await page.route(`**/api/games/${gId}/highlight`, (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            status: "ready",
            highlightObjectPath: FAKE_HIGHLIGHT_PATH,
            error: null,
            startedAt: "2026-01-15T20:00:00.000Z",
            eligibleMoments: 6,
            onFilmMoments: 6,
            musicTrack: null,
          }),
        }),
      );
      await page.route(`**/api/games/${gId}/lowlight`, (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            status: "ready",
            lowlightObjectPath: FAKE_LOWLIGHT_PATH,
            error: null,
            startedAt: "2026-01-15T20:10:00.000Z",
            eligibleMoments: 4,
            onFilmMoments: 4,
            musicTrack: null,
          }),
        }),
      );
      await page.route("**/api/storage/objects/**", (route) =>
        route.fulfill({ status: 200, body: "" }),
      );

      // Clear localStorage so the only source of truth is the null server value.
      await page.evaluate((keys: string[]) => {
        for (const k of keys) localStorage.removeItem(k);
      }, [HIGHLIGHT_LAST_USED_KEY, LOWLIGHT_LAST_USED_KEY]);

      await page.goto(`/record/${gId}`);

      await expect(page.getByText("Highlight Reel")).toBeVisible({ timeout: 15_000 });

      const highlightBadge = page
        .locator("p.text-xs")
        .filter({ hasText: /Generated with:/i })
        .first();

      await expect(highlightBadge).toContainText("No music", { timeout: 10_000 });
    },
  );
});
