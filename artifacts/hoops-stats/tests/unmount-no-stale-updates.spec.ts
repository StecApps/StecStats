/**
 * unmount-no-stale-updates.spec.ts
 *
 * Verifies that navigating away from the record page while a live-stream
 * reconnect is in progress does NOT leave dangling timers that fire React
 * state-update calls on the now-unmounted component.
 *
 * Specifically exercised timers
 * ─────────────────────────────
 * liveReconnectIntervalRef  — 1 s setInterval that ticks the elapsed/countdown
 *   counters in the reconnecting banner.  Started by the effect at line ~734
 *   when `isReconnectingLive` becomes true.  Cleanup fires both on state change
 *   and on unmount; we confirm it actually fires on unmount here.
 *
 * turnCheckIntervalRef  — 25 min interval (won't fire in this test window, but
 *   we also arm the TURN-at-go-live ref so the health-check codepath is live
 *   and any future regression would surface here).
 *
 * How navigation is triggered
 * ───────────────────────────
 * wouter's router listens to `popstate`.  We call `history.pushState` then
 * dispatch a synthetic `popstate` event so that wouter performs a SPA route
 * change (unmounting record.tsx) without a full page reload.
 *
 * What is mocked vs exercised
 * ───────────────────────────
 * Mocked  : billing status (pro), players, teams, ice-servers, any other API
 * Exercised: record.tsx mount → reconnect timer start → unmount cleanup
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
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test-unmount.example.com`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Record page – no stale state updates after navigating away mid-stream", () => {
  let userId: string;
  const email = uniqueEmail("unmount");
  const password = "UnmountTest!9x";

  test.beforeAll(async () => {
    const user = await createClerkUser(email, password);
    userId = user.id;
  });

  test.afterAll(async () => {
    if (userId) await deleteClerkUser(userId);
  });

  test(
    "no React stale-update warnings fire after navigating away while reconnect timer is active",
    async ({ page }) => {
      // ── 0. Collect console warnings/errors ────────────────────────────────
      const consoleMessages: Array<{ type: string; text: string }> = [];
      page.on("console", (msg) => {
        const type = msg.type();
        if (type === "warning" || type === "error") {
          consoleMessages.push({ type, text: msg.text() });
        }
      });

      await setupClerkTestingToken({ page, userId });

      // ── 1. Mock all API endpoints ──────────────────────────────────────────
      await page.route("**/api/billing/status", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ plan: "pro", active: true }),
        }),
      );
      // OnboardingGate redirects to /onboarding when players is empty.
      // Return one player so the gate lets the record page render.
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
            turnAvailable: true,
          }),
        }),
      );
      await page.goto("/record");

      // ── 2. Wait for the live-stream section to confirm dev hooks are mounted ─
      await expect(page.getByText("Live stream link")).toBeVisible({ timeout: 15_000 });

      // ── 3. Arm the TURN-at-go-live ref (health-check codepath active) ──────
      await page.evaluate(() => (window as any).__hoopsSetTurnAtGoLive(true));

      // ── 4. Simulate a live reconnect in progress — starts the 1 s interval ─
      //       that calls setLiveReconnectElapsedSec / setLiveReconnectCountdownSec
      await page.evaluate(() => (window as any).__hoopsSimulateLiveReconnect(1));

      // Confirm the reconnecting UI is rendered — proves the interval is running.
      await expect(page.getByText(/Reconnecting live stream/)).toBeVisible({
        timeout: 5_000,
      });

      // ── 5. Reset the message buffer so we only capture post-navigation noise ─
      consoleMessages.length = 0;

      // ── 6. Navigate away via a SPA route change (wouter listens to popstate) ─
      //       This unmounts record.tsx without a full page reload.
      await page.evaluate(() => {
        window.history.pushState({}, "", "/dashboard");
        window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
      });

      // Brief pause to let React process the route change (unmount + cleanup).
      await page.waitForTimeout(100);

      // ── 7. Wait > 1 interval period so any leaked timer callback would fire ─
      //       The reconnect interval ticks every 1 000 ms; 1 500 ms is enough
      //       to catch two ticks if cleanup was missed.
      await page.waitForTimeout(1_500);

      // ── 8. Assert no stale-update warnings ────────────────────────────────
      const staleUpdateWarnings = consoleMessages.filter(
        ({ text }) =>
          text.includes("Can't perform a React state update on an unmounted component") ||
          // React 18 rephrased this warning in some builds.
          text.includes("Warning: Can't perform a React state update") ||
          text.includes("unmounted component"),
      );

      expect(
        staleUpdateWarnings.map((m) => m.text),
        "Expected no React stale-state-update warnings after navigating away from record page",
      ).toHaveLength(0);
    },
  );

  test(
    "liveReconnectTimeoutRef is cancelled on unmount — callback never fires after navigation",
    async ({ page }) => {
      // ── 0. Collect console warnings/errors ────────────────────────────────
      const consoleMessages: Array<{ type: string; text: string }> = [];
      page.on("console", (msg) => {
        const type = msg.type();
        if (type === "warning" || type === "error") {
          consoleMessages.push({ type, text: msg.text() });
        }
      });

      await setupClerkTestingToken({ page, userId });

      // ── 1. Mock all API endpoints ──────────────────────────────────────────
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
            turnAvailable: true,
          }),
        }),
      );
      await page.goto("/record");

      // ── 2. Wait for the live-stream section so dev hooks are mounted ───────
      await expect(page.getByText("Live stream link")).toBeVisible({ timeout: 15_000 });

      // ── 3. Arm liveReconnectTimeoutRef with a 300 ms pending timeout ───────
      //       The callback would call setIsReconnectingLive / setLiveReconnectAttempt
      //       on the unmounted component if clearTimeout was never called.
      await page.evaluate(() =>
        (window as any).__hoopsArmReconnectTimeout(300),
      );

      // ── 4. Reset message buffer so only post-navigation noise counts ───────
      consoleMessages.length = 0;

      // ── 5. Navigate away immediately — unmount must clearTimeout ──────────
      await page.evaluate(() => {
        window.history.pushState({}, "", "/dashboard");
        window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
      });

      // Brief pause to let React process the unmount and run cleanup effects.
      await page.waitForTimeout(100);

      // ── 6. Wait longer than the armed timeout (300 ms) ────────────────────
      //       If clearTimeout was missed the callback fires here, sets the flag,
      //       and calls state setters on the now-unmounted component.
      await page.waitForTimeout(600);

      // ── 7. Assert the timeout callback never fired ────────────────────────
      const timeoutFired = await page.evaluate(
        () => (window as any).__hoopsReconnectTimeoutFired,
      );
      expect(
        timeoutFired,
        "liveReconnectTimeoutRef callback must NOT fire after the component unmounts",
      ).toBeFalsy();

      // ── 8. Assert no stale-update warnings ────────────────────────────────
      const staleUpdateWarnings = consoleMessages.filter(
        ({ text }) =>
          text.includes("Can't perform a React state update on an unmounted component") ||
          text.includes("Warning: Can't perform a React state update") ||
          text.includes("unmounted component"),
      );
      expect(
        staleUpdateWarnings.map((m) => m.text),
        "Expected no React stale-state-update warnings after liveReconnectTimeoutRef fires post-unmount",
      ).toHaveLength(0);
    },
  );
});
