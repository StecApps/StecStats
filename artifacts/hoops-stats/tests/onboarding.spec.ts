/**
 * Onboarding skip / redirect behaviour — three regression scenarios:
 *
 *  A. Fresh coach  → sees step 1 (player) → step 2 (team) → done screen
 *  B. Coach who already has a player → skips to step 2 (team) directly
 *  C. Fully onboarded coach → navigating to /onboarding auto-redirects to /dashboard
 */

import { test, expect } from "@playwright/test";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

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

async function deleteClerkUser(clerkUserId: string): Promise<void> {
  await fetch(`https://api.clerk.com/v1/users/${clerkUserId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${CLERK_SECRET_KEY}` },
  });
}

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test-onboarding.example.com`;
}

test.describe("Onboarding step routing", () => {
  test("A – fresh coach sees player step first, then team step, then done screen", async ({ page }) => {
    const email = uniqueEmail("fresh");
    const user = await createClerkUser(email, "SomeTestPassword!9x");

    try {
      await setupClerkTestingToken({ page, userId: user.id });
      await page.goto("/onboarding");

      await expect(page.getByTestId("input-onboarding-player-name")).toBeVisible();
      await expect(page.getByTestId("button-onboarding-create-player")).toBeVisible();
      await expect(page.getByTestId("input-onboarding-team-name")).not.toBeVisible();

      await page.getByTestId("input-onboarding-player-name").fill("Test Player");
      await page.getByTestId("button-onboarding-create-player").click();

      await expect(page.getByTestId("input-onboarding-team-name")).toBeVisible();
      await expect(page.getByTestId("button-onboarding-create-team")).toBeVisible();
      await expect(page.getByTestId("input-onboarding-player-name")).not.toBeVisible();

      await page.getByTestId("input-onboarding-team-name").fill("Test Team");
      await page.getByTestId("button-onboarding-create-team").click();

      await expect(page.getByTestId("button-onboarding-finish")).toBeVisible();
      await expect(page.getByTestId("input-onboarding-player-name")).not.toBeVisible();
      await expect(page.getByTestId("input-onboarding-team-name")).not.toBeVisible();

      await page.getByTestId("button-onboarding-finish").click();
      await expect(page).toHaveURL(/\/dashboard/);
    } finally {
      await deleteClerkUser(user.id);
    }
  });

  test("B – coach with an existing player skips step 1 and lands on the team step", async ({ page }) => {
    const email = uniqueEmail("reentrant");
    const user = await createClerkUser(email, "SomeTestPassword!9x");

    try {
      await setupClerkTestingToken({ page, userId: user.id });

      await page.goto("/dashboard");
      await page.waitForLoadState("networkidle");

      const created = await page.evaluate(async (apiBase: string) => {
        const res = await fetch(`${apiBase}/players`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Pre-existing Player" }),
        });
        return res.ok;
      }, API_BASE);
      expect(created).toBe(true);

      await page.goto("/onboarding");

      await expect(page.getByTestId("input-onboarding-team-name")).toBeVisible();
      await expect(page.getByTestId("button-onboarding-create-team")).toBeVisible();
      await expect(page.getByTestId("input-onboarding-player-name")).not.toBeVisible();
    } finally {
      await deleteClerkUser(user.id);
    }
  });

  test("C – fully onboarded coach navigating to /onboarding is redirected to /dashboard", async ({ page }) => {
    const email = uniqueEmail("done");
    const user = await createClerkUser(email, "SomeTestPassword!9x");

    try {
      await setupClerkTestingToken({ page, userId: user.id });

      await page.goto("/dashboard");
      await page.waitForLoadState("networkidle");

      const playerOk = await page.evaluate(async (apiBase: string) => {
        const res = await fetch(`${apiBase}/players`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Pre-existing Player" }),
        });
        return res.ok;
      }, API_BASE);
      expect(playerOk).toBe(true);

      const teamOk = await page.evaluate(async (apiBase: string) => {
        const res = await fetch(`${apiBase}/teams`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Pre-existing Team" }),
        });
        return res.ok;
      }, API_BASE);
      expect(teamOk).toBe(true);

      await page.goto("/onboarding");
      await page.waitForLoadState("networkidle");

      await expect(page).toHaveURL(/\/dashboard/);
      await expect(page.getByTestId("input-onboarding-player-name")).not.toBeVisible();
      await expect(page.getByTestId("input-onboarding-team-name")).not.toBeVisible();
    } finally {
      await deleteClerkUser(user.id);
    }
  });
});
