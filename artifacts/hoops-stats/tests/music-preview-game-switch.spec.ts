/**
 * music-preview-game-switch.spec.ts
 *
 * Confirms that an in-progress music preview is stopped immediately when a
 * coach navigates directly from one game's edit page to another game's edit
 * page — not only when they press Back or leave the section entirely.
 *
 * Root cause addressed
 * ────────────────────
 * The original cleanup useEffect in record.tsx had [] as its dependency array.
 * When React reuses the component instance (same route component, different
 * :id param), it does NOT unmount/remount — the cleanup never fires, so the
 * audio singleton in MusicTrackSelector.tsx keeps playing.
 *
 * The fix changes the dep array to [gameId] so the cleanup also fires on
 * every gameId change, which covers the direct-link case.
 *
 * How it works
 * ────────────
 * • All HTTP routes are mocked so no real API calls are needed.
 * • The audio preview endpoint is mocked to return a minimal valid MP3 so the
 *   HTMLAudioElement can actually start (not just error-out immediately).
 * • DEV-only window hooks exposed by MusicTrackSelector.tsx let the test drive
 *   the module-level singleton:
 *     __hoopsStartMusicPreview(trackId)  – calls startPreview()
 *     __hoopsGetPreviewTrackId()         – returns sharedAudioTrackId (null when stopped)
 * • Navigation from /record/1 to /record/2 is done via history.pushState +
 *   a synthetic popstate event — the same technique wouter uses internally —
 *   so the SPA route changes without a full page reload.
 */

import { test, expect } from "@playwright/test";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

// ---------------------------------------------------------------------------
// Clerk user lifecycle helpers
// ---------------------------------------------------------------------------

const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY ?? "";

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
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test-music.example.com`;
}

// ---------------------------------------------------------------------------
// Minimal silent MP3 (44 bytes) — enough for HTMLAudioElement to accept the
// src without firing an error event immediately, so the preview "starts".
// ---------------------------------------------------------------------------
const SILENT_MP3_B64 =
  "//uQxAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACcQCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Music preview — stops on direct game-to-game navigation", () => {
  let userId: string;
  const email = uniqueEmail("music-switch");
  const password = "MusicSwitch!9x";

  test.beforeAll(async () => {
    const user = await createClerkUser(email, password);
    userId = user.id;
  });

  test.afterAll(async () => {
    if (userId) await deleteClerkUser(userId);
  });

  test(
    "audio preview stops when navigating from /record/1 to /record/2 without unmounting",
    async ({ page }) => {
      await setupClerkTestingToken({ page, userId });

      // ── Mock all required HTTP endpoints ────────────────────────────────────
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
          body: JSON.stringify([{ id: 1, name: "Test Player", teamId: 1 }]),
        }),
      );
      await page.route("**/api/teams", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([{ id: 1, name: "Test Team", sport: "basketball" }]),
        }),
      );
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

      // Stub both game records so /record/1 and /record/2 render in edit mode.
      const makeGame = (id: number) => ({
        id,
        teamId: 1,
        opponent: `Opponent ${id}`,
        date: "2025-01-01",
        teamScore: 10,
        opponentScore: 8,
        videoObjectPath: null,
        highlightObjectPath: null,
        createdAt: "2025-01-01T00:00:00Z",
      });
      await page.route("**/api/games/1", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(makeGame(1)),
        }),
      );
      await page.route("**/api/games/1/highlight", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ status: "idle" }),
        }),
      );
      await page.route("**/api/games/1/lowlight", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ status: "idle" }),
        }),
      );
      await page.route("**/api/games/2", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(makeGame(2)),
        }),
      );
      await page.route("**/api/games/2/highlight", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ status: "idle" }),
        }),
      );
      await page.route("**/api/games/2/lowlight", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ status: "idle" }),
        }),
      );

      // Return a minimal silent MP3 for any track preview so HTMLAudioElement
      // can "start" the audio (and the singleton is considered active).
      await page.route("**/api/music/tracks/*/preview", (route) => {
        const mp3 = Buffer.from(SILENT_MP3_B64, "base64");
        route.fulfill({
          status: 200,
          contentType: "audio/mpeg",
          body: mp3,
        });
      });

      // ── 1. Load game A's edit page ───────────────────────────────────────
      await page.goto("/record/1");

      // Wait for the page to render enough that the MusicTrackSelector DEV
      // hooks are registered (they live in the module scope, loaded at import
      // time, so any render of the component is sufficient).
      await expect(page.getByText("Live stream link")).toBeVisible({ timeout: 15_000 });

      // ── 2. Start a music preview via the DEV hook ────────────────────────
      await page.evaluate(() =>
        (window as any).__hoopsStartMusicPreview("energetic"),
      );

      // Confirm the singleton is active.
      const trackAfterStart: string | null = await page.evaluate(() =>
        (window as any).__hoopsGetPreviewTrackId(),
      );
      expect(trackAfterStart).toBe("energetic");

      // ── 3. Navigate directly to game B's edit page (SPA, no page reload) ─
      //    wouter listens to popstate; pushState + dispatch is the standard
      //    way to trigger a client-side route change in tests.
      await page.evaluate(() => {
        window.history.pushState({}, "", "/record/2");
        window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
      });

      // Brief pause to let React process the route change and run the cleanup.
      await page.waitForTimeout(100);

      // ── 4. Preview must be stopped ────────────────────────────────────────
      const trackAfterNav: string | null = await page.evaluate(() =>
        (window as any).__hoopsGetPreviewTrackId(),
      );
      expect(
        trackAfterNav,
        "Music preview singleton must be null after navigating to a different game",
      ).toBeNull();
    },
  );
});
