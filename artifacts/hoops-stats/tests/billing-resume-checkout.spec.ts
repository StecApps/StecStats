/**
 * E2E regression test: resume-checkout banner on /billing
 *
 * Guards the critical path where a new coach whose auto-resumed checkout
 * fails can still reach Stripe from the Billing page without hitting a dead end.
 *
 * Covers:
 *  1. Banner appears when FAILED_CHECKOUT_KEY is present in localStorage
 *  2. Dismiss (X) removes the banner and clears the localStorage key
 *  3. "Try Pro — Monthly" button triggers the checkout flow (API call confirmed)
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";
import { createClerkClient } from "@clerk/backend";

const FAILED_CHECKOUT_KEY = "stec-failed-checkout";

const clerkClient = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
});

type TestUser = { id: string; email: string };

async function createTestUser(): Promise<TestUser> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const email = `billing-test-${suffix}+clerk_test@example.com`;
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

async function signInAndSetupPlayer(
  page: Page,
  context: BrowserContext,
  email: string,
) {
  await setupClerkTestingToken({ context });
  await page.goto("/");
  await clerk.signIn({ page, emailAddress: email });

  // New users have no players, which triggers OnboardingGate to redirect to
  // /onboarding before reaching /billing. Create one player via the API so the
  // gate passes and the billing page is reachable.
  // Skip if a player already exists (free plan allows only 1).
  const existing = await page.request.get("/api/players");
  const players = existing.ok() ? await existing.json() : [];
  if (players.length === 0) {
    const response = await page.request.post("/api/players", {
      data: { name: "Test Player" },
    });
    if (!response.ok()) {
      throw new Error(
        `Failed to create player: ${response.status()} ${await response.text()}`,
      );
    }
  }
}

test.describe("Billing page – resume-checkout banner", () => {
  let user: TestUser;

  test.beforeAll(async () => {
    user = await createTestUser();
  });

  test.afterAll(async () => {
    await deleteTestUser(user.id);
  });

  test("banner is visible when FAILED_CHECKOUT_KEY is set and plan is free", async ({
    page,
    context,
  }) => {
    await signInAndSetupPlayer(page, context, user.email);

    await page.evaluate(
      ({ key, value }) => localStorage.setItem(key, value),
      { key: FAILED_CHECKOUT_KEY, value: JSON.stringify({ interval: "month", tier: "pro" }) },
    );

    await page.goto("/billing");

    await expect(
      page.getByTestId("resume-checkout-banner"),
    ).toBeVisible({ timeout: 15000 });

    await expect(
      page.getByTestId("resume-checkout-banner"),
    ).toContainText("Start your free trial");

    await expect(page.getByTestId("button-resume-monthly")).toBeVisible();
    await expect(page.getByTestId("button-resume-yearly")).toBeVisible();
  });

  test("dismiss button removes the banner and clears localStorage", async ({
    page,
    context,
  }) => {
    await signInAndSetupPlayer(page, context, user.email);

    await page.evaluate(
      ({ key, value }) => localStorage.setItem(key, value),
      { key: FAILED_CHECKOUT_KEY, value: JSON.stringify({ interval: "month", tier: "pro" }) },
    );

    await page.goto("/billing");

    const banner = page.getByTestId("resume-checkout-banner");
    await expect(banner).toBeVisible({ timeout: 15000 });

    await page.getByRole("button", { name: "Dismiss" }).click();

    await expect(banner).not.toBeVisible({ timeout: 5000 });

    const storedValue = await page.evaluate(
      ({ key }) => localStorage.getItem(key),
      { key: FAILED_CHECKOUT_KEY },
    );
    expect(storedValue).toBeNull();
  });

  test("Try Pro Monthly button triggers the checkout flow", async ({
    page,
    context,
  }) => {
    await signInAndSetupPlayer(page, context, user.email);

    await page.evaluate(
      ({ key, value }) => localStorage.setItem(key, value),
      { key: FAILED_CHECKOUT_KEY, value: JSON.stringify({ interval: "month", tier: "pro" }) },
    );

    await page.goto("/billing");

    const banner = page.getByTestId("resume-checkout-banner");
    await expect(banner).toBeVisible({ timeout: 15000 });

    const monthlyBtn = page.getByTestId("button-resume-monthly");
    await expect(monthlyBtn).toBeVisible();
    await expect(monthlyBtn).toBeEnabled();

    const [checkoutRequest] = await Promise.all([
      page.waitForRequest(
        (req) =>
          req.url().includes("/api/billing/checkout") &&
          req.method() === "POST",
        { timeout: 15000 },
      ),
      monthlyBtn.click(),
    ]);

    expect(checkoutRequest).toBeTruthy();
    const body = checkoutRequest.postDataJSON() as { data?: { interval?: string; tier?: string } };
    expect(body?.data?.tier).toBe("pro");
    expect(body?.data?.interval).toBe("month");
  });
});
