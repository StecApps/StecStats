/**
 * E2E regression test: free-plan upgrade mid-onboarding
 *
 * Scenario: a free-plan coach adds their first player, hits the 1-player limit
 * (upgrade prompt appears), then upgrades to Pro (simulated via the RevenueCat
 * webhook) and returns to /onboarding. The already-confirmed player must still
 * be shown in the roster list, the limit-hit banner must be gone, and a second
 * player must be addable.
 *
 * Why this matters: `confirmedPlayers` is React state that resets on navigation,
 * but the player was persisted to the DB so it must reappear via the server
 * query. `limitHit` must also reset on navigation so the form is usable again.
 */

import { test, expect } from "@playwright/test";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import { createClerkClient } from "@clerk/backend";

const clerkClient = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
});

const API_BASE = process.env.REPLIT_DEV_DOMAIN
  ? `https://${process.env.REPLIT_DEV_DOMAIN}/api`
  : `http://localhost:${process.env.PORT ?? 5173}/api`;

type ClerkUser = { id: string };

async function createTestUser(): Promise<ClerkUser> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const email = `upgrade-mid-onboarding-${suffix}+clerk_test@example.com`;
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

/**
 * Simulate a RevenueCat "pro" entitlement grant by posting a synthetic
 * INITIAL_PURCHASE event to the local webhook endpoint. This updates
 * `users.revenue_cat_entitlement` in the DB exactly as a real RC event would,
 * without requiring a real Stripe subscription.
 */
async function grantProViaRcWebhook(
  request: import("@playwright/test").APIRequestContext,
  clerkUserId: string,
) {
  const secret = process.env.REVENUECAT_WEBHOOK_SECRET;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (secret) {
    headers["Authorization"] = `Bearer ${secret}`;
  }

  const res = await request.post(`${API_BASE}/revenuecat/webhook`, {
    headers,
    data: {
      event: {
        type: "INITIAL_PURCHASE",
        app_user_id: clerkUserId,
        entitlement_ids: ["pro"],
      },
    },
  });

  if (!res.ok()) {
    throw new Error(
      `RC webhook call failed: ${res.status()} ${await res.text()}`,
    );
  }
}

test.describe("Onboarding – upgrade mid-flow roster carry-over", () => {
  test("D – first player survives after free-plan upgrade and a second player can be added", async ({
    page,
    request,
  }) => {
    const user = await createTestUser();

    try {
      await setupClerkTestingToken({ page, userId: user.id });

      // ── Step 1: land on onboarding as a fresh free-plan coach ────────────
      await page.goto("/onboarding");

      await expect(
        page.getByTestId("input-onboarding-player-name"),
      ).toBeVisible();

      // ── Step 2: add the first player (should succeed on free plan) ────────
      await page.getByTestId("input-onboarding-player-name").fill("Alice");
      await page.getByTestId("button-onboarding-add-player").click();

      // Alice appears in the confirmed list
      await expect(
        page.getByTestId("onboarding-player-list"),
      ).toContainText("Alice");

      // ── Step 3: try to add a second player → limit hit → upgrade prompt ──
      await expect(
        page.getByTestId("input-onboarding-player-name"),
      ).toBeVisible();
      await page.getByTestId("input-onboarding-player-name").fill("Bob");
      await page.getByTestId("button-onboarding-add-player").click();

      // The upgrade prompt must appear and the add-player input must be gone
      await expect(
        page.getByTestId("onboarding-upgrade-prompt"),
      ).toBeVisible();
      await expect(
        page.getByTestId("input-onboarding-player-name"),
      ).not.toBeVisible();

      // ── Step 4: simulate upgrade via RevenueCat webhook ───────────────────
      await grantProViaRcWebhook(request, user.id);

      // ── Step 5: return to /onboarding (as if coming back from /billing) ──
      await page.goto("/onboarding");

      // The limit-hit banner must be gone (React state resets on navigation)
      await expect(
        page.getByTestId("onboarding-upgrade-prompt"),
      ).not.toBeVisible();

      // Alice must still appear (she was persisted to the DB and comes back
      // through the useListPlayers query as an existing player)
      await expect(
        page.getByTestId("onboarding-player-list"),
      ).toContainText("Alice");

      // The add-player form must be visible again (limitHit was reset)
      await expect(
        page.getByTestId("input-onboarding-player-name"),
      ).toBeVisible();

      // ── Step 6: add Bob — must succeed now that the user is on Pro ─────────
      await page.getByTestId("input-onboarding-player-name").fill("Bob");
      await page.getByTestId("button-onboarding-add-player").click();

      // Both players must now appear in the list
      await expect(
        page.getByTestId("onboarding-player-list"),
      ).toContainText("Alice");
      await expect(
        page.getByTestId("onboarding-player-list"),
      ).toContainText("Bob");

      // The upgrade prompt must NOT have re-appeared
      await expect(
        page.getByTestId("onboarding-upgrade-prompt"),
      ).not.toBeVisible();
    } finally {
      await deleteTestUser(user.id);
    }
  });
});
