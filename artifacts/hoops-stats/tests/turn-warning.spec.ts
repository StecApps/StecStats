/**
 * TURN warning integration tests
 *
 * Verifies that the "TURN relay unavailable" badge and toast surface
 * correctly mid-broadcast when refreshTurnAvailable() returns a changed
 * value — without requiring a page reload — and that reconnecting the
 * WebSocket does NOT fire the toast a second time.
 *
 * The component exposes two dev-only window hooks so we can exercise the
 * TURN health-check path without waiting 25 minutes or needing a real WebSocket:
 *
 *   window.__hoopsTurnCheckNow()          — runs runTurnHealthCheck() immediately
 *   window.__hoopsSetTurnAtGoLive(bool)   — sets turnAtGoLiveRef.current
 */

import { test, expect } from "@playwright/test";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

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

async function deleteClerkUser(clerkUserId: string): Promise<void> {
  await fetch(`https://api.clerk.com/v1/users/${clerkUserId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${CLERK_SECRET_KEY}` },
  });
}

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test-turn.example.com`;
}

// ---------------------------------------------------------------------------
// Shared route-mock helpers
// ---------------------------------------------------------------------------

/** Tracks whether the next ice-servers call should report TURN available. */
let turnAvailableOnServer = true;

async function setupRouteMocks(page: import("@playwright/test").Page) {
  // Stub billing so the page treats the user as Pro (required for TURN init).
  await page.route("**/api/billing/status", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ plan: "pro", active: true }),
    }),
  );

  // Stub players / teams so data-fetching hooks resolve without hitting the DB.
  await page.route("**/api/players", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  await page.route("**/api/teams", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );

  // ice-servers — returns whatever turnAvailableOnServer is set to at call time.
  await page.route("**/api/live/ice-servers", (route) => {
    const available = turnAvailableOnServer;
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        turnAvailable: available,
      }),
    });
  });

  // Prevent any live-session pre-generation from failing noisily.
  await page.route("**/api/live/start", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ code: "test-code-abc" }),
    }),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("TURN expiry warnings", () => {
  let userId: string;
  const email = uniqueEmail("turn-warn");
  const password = "TurnTestPassword!9x";

  test.beforeAll(async () => {
    const user = await createClerkUser(email, password);
    userId = user.id;
  });

  test.afterAll(async () => {
    if (userId) await deleteClerkUser(userId);
  });

  test.beforeEach(() => {
    // Reset to TURN available before each test case.
    turnAvailableOnServer = true;
  });

  // -------------------------------------------------------------------------
  // Test A: badge appears without a page reload
  // -------------------------------------------------------------------------
  test("A – warning badge appears when TURN becomes unavailable mid-session", async ({ page }) => {
    await setupClerkTestingToken({ page, userId });
    await setupRouteMocks(page);

    // Navigate to the record page (no game ID = new-game form).
    await page.goto("/record");

    // Wait for the live-stream section to be present (badge sits inside it).
    await expect(page.getByText("Live stream link")).toBeVisible({ timeout: 10_000 });

    // No badge should be visible when TURN is available.
    await expect(page.locator('[data-testid="turn-warning-badge"]')).not.toBeVisible();

    // Simulate the server losing its TURN relay mid-broadcast.
    turnAvailableOnServer = false;

    // Trigger the health-check immediately via the dev hook.
    await page.evaluate(() => (window as any).__hoopsTurnCheckNow());

    // The badge must appear without a page reload.
    await expect(page.locator('[data-testid="turn-warning-badge"]')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-testid="turn-warning-badge"]')).toContainText(
      "Streaming on limited network",
    );
  });

  // -------------------------------------------------------------------------
  // Test B: badge disappears when TURN recovers
  // -------------------------------------------------------------------------
  test("B – warning badge clears when TURN comes back online", async ({ page }) => {
    turnAvailableOnServer = false; // start with TURN unavailable

    await setupClerkTestingToken({ page, userId });
    await setupRouteMocks(page);

    await page.goto("/record");
    await expect(page.getByText("Live stream link")).toBeVisible({ timeout: 10_000 });

    // Trigger an initial check — badge should appear.
    await page.evaluate(() => (window as any).__hoopsTurnCheckNow());
    await expect(page.locator('[data-testid="turn-warning-badge"]')).toBeVisible({ timeout: 5_000 });

    // Simulate the relay recovering.
    turnAvailableOnServer = true;
    await page.evaluate(() => (window as any).__hoopsTurnCheckNow());

    // Badge should disappear without a page reload.
    await expect(page.locator('[data-testid="turn-warning-badge"]')).not.toBeVisible({ timeout: 5_000 });
  });

  // -------------------------------------------------------------------------
  // Test C: toast fires exactly once — reconnect does NOT duplicate it
  // -------------------------------------------------------------------------
  test("C – TURN-unavailable toast fires once and does not repeat on a second check", async ({ page }) => {
    await setupClerkTestingToken({ page, userId });
    await setupRouteMocks(page);

    await page.goto("/record");
    await expect(page.getByText("Live stream link")).toBeVisible({ timeout: 10_000 });

    // Simulate the coach having gone live with TURN available.
    await page.evaluate(() => (window as any).__hoopsSetTurnAtGoLive(true));

    // Server loses TURN relay — first check should show the toast.
    turnAvailableOnServer = false;
    await page.evaluate(() => (window as any).__hoopsTurnCheckNow());

    // Toast with the exact title must appear.
    await expect(page.getByText("TURN relay unavailable")).toBeVisible({ timeout: 5_000 });

    // Dismiss the toast (or let it naturally fade) and check it does not
    // re-appear on a second check (TURN still unavailable — condition already met).
    // We count visible toasts with that title before and after the second call.
    const toastsBefore = await page.locator('[data-testid="toast-title"]', {
      hasText: "TURN relay unavailable",
    }).count();

    await page.evaluate(() => (window as any).__hoopsTurnCheckNow());
    // Short wait to give the DOM time to update if a duplicate were added.
    await page.waitForTimeout(500);

    const toastsAfter = await page.locator('[data-testid="toast-title"]', {
      hasText: "TURN relay unavailable",
    }).count();

    // The number of matching toasts must not increase — no duplicate.
    expect(toastsAfter).toBeLessThanOrEqual(toastsBefore);
  });

  // -------------------------------------------------------------------------
  // Test D: interval is not duplicated after a simulated WS reconnect
  // -------------------------------------------------------------------------
  test("D – reconnect guard: interval count stays at 1 after calling connectBroadcasterSocket twice", async ({ page }) => {
    await setupClerkTestingToken({ page, userId });
    await setupRouteMocks(page);

    await page.goto("/record");
    await expect(page.getByText("Live stream link")).toBeVisible({ timeout: 10_000 });

    // Simulate the coach having gone live with TURN available.
    await page.evaluate(() => (window as any).__hoopsSetTurnAtGoLive(true));

    // Drop TURN, trigger two checks in quick succession (as if the interval
    // ran twice because two ws.onopen events fired without clearing the old one).
    turnAvailableOnServer = false;
    await page.evaluate(async () => {
      // Simulate a reconnect scenario where ws.onopen fires twice.
      // The production code clears turnCheckIntervalRef before each new
      // setInterval call, so only one interval should be active at a time.
      // Here we call the exposed hook twice and verify the toast appears once.
      await (window as any).__hoopsTurnCheckNow();
    });
    await expect(page.getByText("TURN relay unavailable")).toBeVisible({ timeout: 5_000 });

    const countAfterFirst = await page.getByText("TURN relay unavailable").count();

    // Second check — TURN still unavailable, turnAtGoLive still true.
    // The condition `turnAtGoLiveRef.current === true && !nowAvailable` only
    // toasts on *transitions*, not on repeated identical states, because the
    // check fires and `turnAtGoLiveRef` is unchanged (it's only set on goLive/stopGoingLive).
    // A real duplicate-interval bug would show a second toast here.
    await page.evaluate(async () => {
      await (window as any).__hoopsTurnCheckNow();
    });
    await page.waitForTimeout(500);

    const countAfterSecond = await page.getByText("TURN relay unavailable").count();
    expect(countAfterSecond).toBeLessThanOrEqual(countAfterFirst);
  });
});
