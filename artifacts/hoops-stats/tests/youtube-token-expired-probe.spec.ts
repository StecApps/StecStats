/**
 * E2E regression test: YouTube reconnect prompt appears before upload is pressed
 *
 * Guards the probe-then-redirect flow: when /api/auth/youtube/status?probe=true
 * returns connected:false (e.g. a revoked/expired token), the Record page must
 * show the "Connect YouTube" button immediately — without waiting for the coach
 * to press the upload button and receive a server-side 403.
 *
 * Scenarios covered:
 *  1. Probe returns connected:false (200) → button reads "Connect YouTube";
 *     clicking it navigates to the OAuth connect URL, not a dialog.
 *  2. Probe returns a non-OK status (simulated 401) → catch path also surfaces
 *     "Connect YouTube", confirming any probe failure is handled safely.
 *
 * Technique: the YouTube button is gated by
 *   isPro && existingVideoObjectPath && highlight.status === "ready"
 * so billing/game/highlight are mocked accordingly (same pattern as the
 * youtube-billing-disconnect spec).
 */

import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";
import { createClerkClient } from "@clerk/backend";

const clerkClient = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
});

type TestUser = { id: string; email: string };

async function createTestUser(prefix: string): Promise<TestUser> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const email = `yt-probe-${prefix}-${suffix}+clerk_test@example.com`;
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

async function createGameForTest(page: Page): Promise<{ gameId: number; teamId: number }> {
  const playerRes = await page.request.post("/api/players", {
    data: { name: "YT Probe Player" },
  });
  if (!playerRes.ok()) {
    throw new Error(`Failed to create player: ${playerRes.status()} ${await playerRes.text()}`);
  }
  const player = await playerRes.json();

  const teamRes = await page.request.post("/api/teams", {
    data: { name: "YT Probe Team" },
  });
  if (!teamRes.ok()) {
    throw new Error(`Failed to create team: ${teamRes.status()} ${await teamRes.text()}`);
  }
  const team = await teamRes.json();

  const gameRes = await page.request.post("/api/games", {
    data: {
      teamId: team.id,
      opponent: "Rivals",
      date: new Date().toISOString(),
      result: "W",
      teamScore: 68,
      opponentScore: 54,
      stats: [
        {
          playerId: player.id,
          ftMade: 1, ftAttempted: 2,
          twoMade: 4, twoAttempted: 7,
          threeMade: 1, threeAttempted: 3,
          assists: 2, rebounds: 5, steals: 1, turnovers: 0, blocks: 1,
        },
      ],
      events: [],
    },
  });
  if (!gameRes.ok()) {
    throw new Error(`Failed to create game: ${gameRes.status()} ${await gameRes.text()}`);
  }
  const game = await gameRes.json();

  return { gameId: game.id as number, teamId: team.id as number };
}

/** Stub routes that make the YouTube button section visible on the Record page. */
async function stubRecordPagePrerequisites(
  page: Page,
  gameId: number,
  teamId: number,
) {
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

  await page.route(`**/api/games/${gameId}`, (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: gameId,
        teamId,
        teamName: "YT Probe Team",
        opponent: "Rivals",
        date: new Date().toISOString(),
        result: "W",
        teamScore: 68,
        opponentScore: 54,
        videoObjectPath: "test/yt-probe-video.mp4",
        videoOffsetMs: null,
        highlightObjectPath: "test/yt-probe-highlight.mp4",
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
        highlightObjectPath: "test/yt-probe-highlight.mp4",
        error: null,
        startedAt: null,
        eligibleMoments: 4,
      }),
    });
  });

  await page.route(`**/api/games/${gameId}/video-signed-url`, (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ url: "https://example.com/fake-probe-video.mp4" }),
    });
  });

  // Suppress storage fetches for the fake paths.
  await page.route("**/api/storage/**", (route) => {
    route.fulfill({ status: 404, body: "" });
  });
}

// ---------------------------------------------------------------------------

test.describe("YouTube probe: reconnect prompt before upload", () => {
  test.describe("Scenario 1 — probe returns connected:false (200)", () => {
    let user: TestUser;

    test.beforeAll(async () => {
      user = await createTestUser("ok");
    });

    test.afterAll(async () => {
      await deleteTestUser(user.id);
    });

    test(
      "shows 'Connect YouTube' immediately when probe returns connected:false",
      async ({ page, context }) => {
        await signIn(page, context, user.email);

        const { gameId, teamId } = await createGameForTest(page);

        // Stub the probe to return connected:false — the key case being tested.
        await page.route("**/api/auth/youtube/status*", (route) => {
          route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ connected: false }),
          });
        });

        await stubRecordPagePrerequisites(page, gameId, teamId);

        await page.goto(`/record/${gameId}`);

        // The button must say "Connect YouTube" — not "YouTube" — confirming
        // the probe result was acted on before the coach pressed anything.
        const connectBtn = page.getByRole("button", { name: /connect youtube/i });
        await expect(connectBtn).toBeVisible({ timeout: 15_000 });
        await expect(connectBtn).toBeEnabled();

        // The "YouTube" (connected) variant must not be present.
        const connectedBtn = page.getByRole("button", { name: /^youtube$/i });
        await expect(connectedBtn).not.toBeVisible();
      },
    );

    test(
      "clicking 'Connect YouTube' navigates to OAuth — does not open an upload dialog",
      async ({ page, context }) => {
        await signIn(page, context, user.email);

        const { gameId, teamId } = await createGameForTest(page);

        await page.route("**/api/auth/youtube/status*", (route) => {
          route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ connected: false }),
          });
        });

        await stubRecordPagePrerequisites(page, gameId, teamId);

        // Intercept the OAuth redirect so the test doesn't leave the app domain.
        let oauthNavigated = false;
        page.on("request", (req) => {
          if (req.url().includes("/api/auth/youtube/connect")) {
            oauthNavigated = true;
          }
        });

        // Abort the OAuth connect navigation so we stay in-domain.
        await page.route("**/api/auth/youtube/connect*", (route) => {
          oauthNavigated = true;
          route.abort();
        });

        await page.goto(`/record/${gameId}`);

        const connectBtn = page.getByRole("button", { name: /connect youtube/i });
        await expect(connectBtn).toBeVisible({ timeout: 15_000 });
        await connectBtn.click();

        // Navigation to the OAuth endpoint must have been triggered.
        expect(oauthNavigated).toBe(true);

        // The upload dialog must NOT have opened.
        const uploadDialog = page.getByRole("dialog", { name: /upload to youtube/i });
        await expect(uploadDialog).not.toBeVisible();
      },
    );
  });

  test.describe("Scenario 2 — probe returns a non-OK status (401)", () => {
    let user: TestUser;

    test.beforeAll(async () => {
      user = await createTestUser("401");
    });

    test.afterAll(async () => {
      await deleteTestUser(user.id);
    });

    test(
      "shows 'Connect YouTube' when the probe returns a 401 (catch path)",
      async ({ page, context }) => {
        await signIn(page, context, user.email);

        const { gameId, teamId } = await createGameForTest(page);

        // Simulate a 401 from the probe endpoint.  The client-side catch
        // calls setIsYoutubeConnected(false), so the button must still read
        // "Connect YouTube" without crashing.
        await page.route("**/api/auth/youtube/status*", (route) => {
          route.fulfill({
            status: 401,
            contentType: "application/json",
            body: JSON.stringify({ error: "Unauthorized" }),
          });
        });

        await stubRecordPagePrerequisites(page, gameId, teamId);

        await page.goto(`/record/${gameId}`);

        const connectBtn = page.getByRole("button", { name: /connect youtube/i });
        await expect(connectBtn).toBeVisible({ timeout: 15_000 });

        // Connected variant must not appear.
        const connectedBtn = page.getByRole("button", { name: /^youtube$/i });
        await expect(connectedBtn).not.toBeVisible();
      },
    );
  });
});
