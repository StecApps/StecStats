/**
 * E2E regression test: YouTube button state after Billing disconnect
 *
 * Guards against stale YouTube connection state on the Record page after a
 * coach disconnects from Billing. The Record page fetches /api/auth/youtube/status
 * fresh on mount (when isEditing=true), so the button must reflect the real
 * server state — not whatever it was before navigation.
 *
 * Covers:
 *  1. Billing page shows "Disconnect" when YouTube appears connected
 *  2. Clicking Disconnect calls DELETE /api/auth/youtube and updates Billing UI
 *  3. After navigating to Record, the button reads "Connect YouTube" (not "YouTube")
 *     — confirming the mount-time fetch retrieves fresh, post-disconnect state
 *
 * Technique: the Record page's YouTube button section is gated behind
 *   isEditing && existingVideoObjectPath && isPro && highlight.status === "ready"
 * so the test mocks /api/billing/status (→ pro), /api/games/:id (→ includes
 * videoObjectPath), and /api/games/:id/highlight (→ ready) to make that section
 * visible without a real subscription or a real generated reel.
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";
import { createClerkClient } from "@clerk/backend";

const clerkClient = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
});

type TestUser = { id: string; email: string };

async function createTestUser(): Promise<TestUser> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const email = `yt-disconnect-${suffix}+clerk_test@example.com`;
  const user = await clerkClient.users.createUser({
    emailAddress: [email],
    firstName: "Test",
    lastName: "Coach",
    skipPasswordRequirement: true,
  });
  return { id: user.id, email };
}

async function deleteTestUser(id: string) {
  try {
    await clerkClient.users.deleteUser(id);
  } catch {
    // best-effort cleanup
  }
}

async function signIn(page: Page, context: BrowserContext, email: string) {
  await setupClerkTestingToken({ context });
  await page.goto("/");
  await clerk.signIn({ page, emailAddress: email });
}

async function createGameForTest(page: Page): Promise<{ gameId: number; teamId: number; playerId: number }> {
  // Create player (satisfies the onboarding gate).
  const playerRes = await page.request.post("/api/players", {
    data: { name: "YT Test Player" },
  });
  if (!playerRes.ok()) throw new Error(`Failed to create player: ${playerRes.status()} ${await playerRes.text()}`);
  const player = await playerRes.json();

  // Create a team.
  const teamRes = await page.request.post("/api/teams", {
    data: { name: "YT Test Team" },
  });
  if (!teamRes.ok()) throw new Error(`Failed to create team: ${teamRes.status()} ${await teamRes.text()}`);
  const team = await teamRes.json();

  // Create a game (no video — free plan allows this).
  const gameRes = await page.request.post("/api/games", {
    data: {
      teamId: team.id,
      opponent: "Rivals",
      date: new Date().toISOString(),
      result: "W",
      teamScore: 72,
      opponentScore: 58,
      stats: [
        {
          playerId: player.id,
          ftMade: 2, ftAttempted: 3,
          twoMade: 3, twoAttempted: 6,
          threeMade: 2, threeAttempted: 4,
          assists: 3, rebounds: 4, steals: 1, turnovers: 1, blocks: 0,
        },
      ],
      events: [],
    },
  });
  if (!gameRes.ok()) throw new Error(`Failed to create game: ${gameRes.status()} ${await gameRes.text()}`);
  const game = await gameRes.json();

  return { gameId: game.id as number, teamId: team.id as number, playerId: player.id as number };
}

test.describe("YouTube billing disconnect → Record page refresh", () => {
  let user: TestUser;

  test.beforeAll(async () => {
    user = await createTestUser();
  });

  test.afterAll(async () => {
    await deleteTestUser(user.id);
  });

  test("Record page shows 'Connect YouTube' after disconnecting from Billing", async ({
    page,
    context,
  }) => {
    await signIn(page, context, user.email);

    const { gameId, teamId } = await createGameForTest(page);

    // ── Phase 1: Billing page ──────────────────────────────────────────────
    // Intercept YouTube status so Billing believes YouTube is connected.
    // (The user has no real OAuth token — this simulates the connected state
    // without a full OAuth flow.)
    await page.route("**/api/auth/youtube/status", (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ connected: true }),
      });
    });

    await page.goto("/billing");

    // Billing should show the Disconnect button (YouTube appears connected).
    const disconnectBtn = page.getByTestId("button-disconnect-youtube");
    await expect(disconnectBtn).toBeVisible({ timeout: 15_000 });
    await expect(disconnectBtn).toBeEnabled();

    // Remove the mock so the real DELETE and subsequent status fetches go
    // through. The real server has no token → will return connected: false.
    await page.unroute("**/api/auth/youtube/status");

    // Click Disconnect — calls DELETE /api/auth/youtube (real request).
    await disconnectBtn.click();

    // Billing's local state update should hide the disconnect button immediately.
    await expect(disconnectBtn).not.toBeVisible({ timeout: 10_000 });

    // ── Phase 2: Record page ───────────────────────────────────────────────
    // The Record page's YouTube button is gated by:
    //   isPro && existingVideoObjectPath && highlight.status === "ready"
    // Mock all three without a real subscription, video, or generated reel.
    await page.route("**/api/billing/status", (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          plan: "pro",
          status: "active",
          currentPeriodEnd: null,
          trialEnd: null,
          cancelAtPeriodEnd: false,
        }),
      });
    });

    // Make the game look like it has a video so existingVideoObjectPath is set.
    await page.route(`**/api/games/${gameId}`, (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: gameId,
          teamId,
          teamName: "YT Test Team",
          opponent: "Rivals",
          date: new Date().toISOString(),
          result: "W",
          teamScore: 72,
          opponentScore: 58,
          videoObjectPath: "test/yt-e2e-video.mp4",
          videoOffsetMs: null,
          highlightObjectPath: "test/yt-e2e-highlight.mp4",
          highlightStatus: "ready",
          highlightError: null,
          createdAt: new Date().toISOString(),
          stats: [],
          events: [],
        }),
      });
    });

    await page.route(`**/api/games/${gameId}/highlight`, (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "ready",
          highlightObjectPath: "test/yt-e2e-highlight.mp4",
          error: null,
          startedAt: null,
          eligibleMoments: 3,
        }),
      });
    });

    // Stub the video signed-url endpoint to avoid a server-side 404.
    await page.route(`**/api/games/${gameId}/video-signed-url`, (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ url: "https://example.com/fake-video.mp4" }),
      });
    });

    // Suppress storage object fetches for the fake paths.
    await page.route("**/api/storage/**", (route) => {
      route.fulfill({ status: 404, body: "" });
    });

    await page.goto(`/record/${gameId}`);

    // The YouTube button must read "Connect YouTube" — not "YouTube".
    // This confirms the mount-time fetch returned connected:false (the real,
    // post-disconnect server state) rather than any stale in-memory value.
    const youtubeBtn = page.getByRole("button", { name: /connect youtube/i });
    await expect(youtubeBtn).toBeVisible({ timeout: 15_000 });

    // Explicitly confirm the connected variant ("YouTube" alone) is NOT present.
    const connectedVariant = page.getByRole("button", { name: /^youtube$/i });
    await expect(connectedVariant).not.toBeVisible();
  });
});
