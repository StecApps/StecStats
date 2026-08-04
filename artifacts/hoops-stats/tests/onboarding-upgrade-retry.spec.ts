/**
 * Regression tests: handleCreatePlayer retry window after upgrade
 *
 * Task #192 – confirm the upgrade prompt clears before the coach can get
 * stuck retrying on a slow connection.
 *
 * When sessionStorage carries a recent RECENTLY_UPGRADED_KEY stamp,
 * handleCreatePlayer silently retries a POST /players 403 up to two extra
 * times (3 total) with a 2-second gap before showing the "limit hit" banner.
 *
 * Scenarios:
 *  F – 403 on first attempt, success on second → no banner, player added,
 *      sessionStorage stamp cleared
 *  G – three consecutive 403s → banner shown after the last attempt,
 *      sessionStorage stamp NOT cleared (user still needs to upgrade)
 *  H – "Upgrade to Pro" button sets the sessionStorage stamp
 *  I – no stamp (or expired stamp >5 min) → banner appears immediately,
 *      no 2-second retry delay
 */

import { test, expect } from "@playwright/test";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import { createClerkClient } from "@clerk/backend";

const clerkClient = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
});

const RECENTLY_UPGRADED_KEY = "hoops_recently_upgraded_ts";

type ClerkUser = { id: string };

async function createTestUser(): Promise<ClerkUser> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const email = `upgrade-retry-${suffix}+clerk_test@example.com`;
  const user = await clerkClient.users.createUser({
    emailAddress: [email],
    firstName: "Test",
    lastName: "Coach",
    skipPasswordRequirement: true,
  });
  return { id: user.id };
}

async function deleteTestUser(id: string) {
  try {
    await clerkClient.users.deleteUser(id);
  } catch {
    // best-effort cleanup
  }
}

/** Intercept POST /api/players and return a controlled sequence of responses. */
function mockPlayersPost(
  page: import("@playwright/test").Page,
  responses: Array<{ status: number; body: object }>,
) {
  let callIndex = 0;
  return page.route("**/api/players", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const resp = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;
    await route.fulfill({
      status: resp.status,
      contentType: "application/json",
      body: JSON.stringify(resp.body),
    });
  });
}

const FAKE_PLAYER = { id: 999, name: "Bob", ownerId: "u_test" };

test.describe("Onboarding – upgrade retry window", () => {
  test("F – 403 on first attempt, success on second → no banner, player added, stamp cleared", async ({
    page,
  }) => {
    const user = await createTestUser();

    try {
      await setupClerkTestingToken({ page, userId: user.id });

      // Route: first POST → 403 UPGRADE_REQUIRED, second POST → 201 success
      await mockPlayersPost(page, [
        { status: 403, body: { error: "Upgrade required", code: "UPGRADE_REQUIRED" } },
        { status: 201, body: FAKE_PLAYER },
      ]);

      await page.goto("/onboarding");
      await expect(page.getByTestId("input-onboarding-player-name")).toBeVisible();

      // Simulate returning from Stripe: stamp sessionStorage
      await page.evaluate(
        ({ key }) => sessionStorage.setItem(key, String(Date.now())),
        { key: RECENTLY_UPGRADED_KEY },
      );

      // Attempt to add a player — first call will 403, second will succeed
      await page.getByTestId("input-onboarding-player-name").fill("Bob");
      await page.getByTestId("button-onboarding-add-player").click();

      // Wait for the retry (2-second gap) + success
      // The banner must NOT appear
      await expect(page.getByTestId("onboarding-upgrade-prompt")).not.toBeVisible({
        timeout: 8000,
      });

      // Player should appear in the confirmed list (via confirmedPlayers state)
      await expect(page.getByTestId("onboarding-player-list")).toContainText("Bob", {
        timeout: 8000,
      });

      // SessionStorage stamp must have been cleared on success
      const stamp = await page.evaluate(
        ({ key }) => sessionStorage.getItem(key),
        { key: RECENTLY_UPGRADED_KEY },
      );
      expect(stamp).toBeNull();
    } finally {
      await deleteTestUser(user.id);
    }
  });

  test("G – three consecutive 403s → banner shown, stamp NOT cleared", async ({
    page,
  }) => {
    const user = await createTestUser();

    try {
      await setupClerkTestingToken({ page, userId: user.id });

      // Route: all POSTs → 403 UPGRADE_REQUIRED
      await mockPlayersPost(page, [
        { status: 403, body: { error: "Upgrade required", code: "UPGRADE_REQUIRED" } },
      ]);

      await page.goto("/onboarding");
      await expect(page.getByTestId("input-onboarding-player-name")).toBeVisible();

      // Simulate returning from Stripe: stamp sessionStorage
      const stampValue = String(Date.now());
      await page.evaluate(
        ({ key, value }) => sessionStorage.setItem(key, value),
        { key: RECENTLY_UPGRADED_KEY, value: stampValue },
      );

      // Attempt to add a player
      await page.getByTestId("input-onboarding-player-name").fill("Charlie");
      await page.getByTestId("button-onboarding-add-player").click();

      // All 3 attempts 403 → banner must appear (after ~4 s for two retries)
      await expect(page.getByTestId("onboarding-upgrade-prompt")).toBeVisible({
        timeout: 12000,
      });

      // Add-player form must be hidden while the banner is showing
      await expect(page.getByTestId("input-onboarding-player-name")).not.toBeVisible();

      // SessionStorage stamp must still be present (upgrade not confirmed)
      const stamp = await page.evaluate(
        ({ key }) => sessionStorage.getItem(key),
        { key: RECENTLY_UPGRADED_KEY },
      );
      expect(stamp).not.toBeNull();
    } finally {
      await deleteTestUser(user.id);
    }
  });

  test("H – clicking Upgrade to Pro sets the sessionStorage stamp", async ({
    page,
  }) => {
    const user = await createTestUser();

    try {
      await setupClerkTestingToken({ page, userId: user.id });

      // Route: POST /players → 403 so the upgrade prompt appears immediately
      // (no stamp → maxAttempts = 1, no retry)
      await mockPlayersPost(page, [
        { status: 403, body: { error: "Upgrade required", code: "UPGRADE_REQUIRED" } },
      ]);

      await page.goto("/onboarding");
      await expect(page.getByTestId("input-onboarding-player-name")).toBeVisible();

      // Ensure no stamp yet
      await page.evaluate(
        ({ key }) => sessionStorage.removeItem(key),
        { key: RECENTLY_UPGRADED_KEY },
      );

      // Trigger the upgrade prompt
      await page.getByTestId("input-onboarding-player-name").fill("Dave");
      await page.getByTestId("button-onboarding-add-player").click();

      await expect(page.getByTestId("onboarding-upgrade-prompt")).toBeVisible({
        timeout: 8000,
      });

      // Click "Upgrade to Pro" — page navigates to /billing, but intercept the
      // navigation so we can inspect sessionStorage before leaving.
      await page.route("**/billing**", (route) => route.abort());

      // The button sets the stamp and then navigates; catch navigation error
      await page
        .getByTestId("onboarding-upgrade-prompt")
        .getByRole("button", { name: /upgrade to pro/i })
        .click()
        .catch(() => {/* navigation aborted — expected */});

      // Stamp must have been written
      const stamp = await page.evaluate(
        ({ key }) => sessionStorage.getItem(key),
        { key: RECENTLY_UPGRADED_KEY },
      );
      expect(stamp).not.toBeNull();

      // It must be a recent timestamp (within the last 5 seconds)
      const age = Date.now() - Number(stamp);
      expect(age).toBeGreaterThanOrEqual(0);
      expect(age).toBeLessThan(5000);
    } finally {
      await deleteTestUser(user.id);
    }
  });

  test("I (no stamp) – 403 with no sessionStorage stamp → banner appears immediately, no retry delay", async ({
    page,
  }) => {
    const user = await createTestUser();

    try {
      await setupClerkTestingToken({ page, userId: user.id });

      // Track how many times POST /api/players is called
      let postCallCount = 0;
      await page.route("**/api/players", async (route) => {
        if (route.request().method() !== "POST") {
          await route.continue();
          return;
        }
        postCallCount++;
        await route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({ error: "Upgrade required", code: "UPGRADE_REQUIRED" }),
        });
      });

      await page.goto("/onboarding");
      await expect(page.getByTestId("input-onboarding-player-name")).toBeVisible();

      // Ensure no stamp is present
      await page.evaluate(
        ({ key }) => sessionStorage.removeItem(key),
        { key: RECENTLY_UPGRADED_KEY },
      );

      // Attempt to add a player
      await page.getByTestId("input-onboarding-player-name").fill("Eve");
      const clickTime = Date.now();
      await page.getByTestId("button-onboarding-add-player").click();

      // Banner must appear quickly — well under the 2-second retry delay
      await expect(page.getByTestId("onboarding-upgrade-prompt")).toBeVisible({
        timeout: 1500,
      });
      const bannerTime = Date.now() - clickTime;

      // Confirm it appeared in under 1.5 seconds (no 2-second retry pause)
      expect(bannerTime).toBeLessThan(1500);

      // Only one POST should have been made — no silent retry
      expect(postCallCount).toBe(1);

      // Add-player form must be hidden while the banner is showing
      await expect(page.getByTestId("input-onboarding-player-name")).not.toBeVisible();
    } finally {
      await deleteTestUser(user.id);
    }
  });

  test("I (expired stamp) – 403 with stamp older than 5 min → banner appears immediately, no retry delay", async ({
    page,
  }) => {
    const user = await createTestUser();

    try {
      await setupClerkTestingToken({ page, userId: user.id });

      // Track how many times POST /api/players is called
      let postCallCount = 0;
      await page.route("**/api/players", async (route) => {
        if (route.request().method() !== "POST") {
          await route.continue();
          return;
        }
        postCallCount++;
        await route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({ error: "Upgrade required", code: "UPGRADE_REQUIRED" }),
        });
      });

      await page.goto("/onboarding");
      await expect(page.getByTestId("input-onboarding-player-name")).toBeVisible();

      // Set an expired stamp: 6 minutes ago (older than the 5-minute window)
      const expiredTs = String(Date.now() - 6 * 60 * 1000);
      await page.evaluate(
        ({ key, value }) => sessionStorage.setItem(key, value),
        { key: RECENTLY_UPGRADED_KEY, value: expiredTs },
      );

      // Attempt to add a player
      await page.getByTestId("input-onboarding-player-name").fill("Frank");
      const clickTime = Date.now();
      await page.getByTestId("button-onboarding-add-player").click();

      // Banner must appear quickly — well under the 2-second retry delay
      await expect(page.getByTestId("onboarding-upgrade-prompt")).toBeVisible({
        timeout: 1500,
      });
      const bannerTime = Date.now() - clickTime;

      // Confirm it appeared in under 1.5 seconds (no 2-second retry pause)
      expect(bannerTime).toBeLessThan(1500);

      // Only one POST should have been made — no silent retry
      expect(postCallCount).toBe(1);

      // Add-player form must be hidden while the banner is showing
      await expect(page.getByTestId("input-onboarding-player-name")).not.toBeVisible();
    } finally {
      await deleteTestUser(user.id);
    }
  });
});
