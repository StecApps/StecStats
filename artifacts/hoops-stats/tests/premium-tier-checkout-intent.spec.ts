/**
 * E2E regression test: Premium tier carries through the checkout intent flow
 *
 * Guards the critical path where a user who selects the Premium plan (either on
 * the pricing page or billing page) has tier="premium" correctly encoded in
 * sessionStorage / localStorage, and that:
 *
 *  1. PENDING_CHECKOUT_KEY encodes tier="premium" so PendingCheckoutResumer
 *     fires a checkout request with tier="premium" (not tier="pro").
 *  2. The billing resume banner shows "Premium" labels — not "Pro" — when the
 *     stored FAILED_CHECKOUT_KEY intent has tier="premium".
 *  3. The resume banner buttons ("Try Premium — Monthly / Yearly") include the
 *     word "Premium", and clicking Monthly sends a checkout request with
 *     tier="premium" in the request body.
 *
 * Relevant files:
 *   artifacts/hoops-stats/src/pages/pricing.tsx  (PENDING_CHECKOUT_KEY, encodeCheckoutIntent)
 *   artifacts/hoops-stats/src/App.tsx             (PendingCheckoutResumer)
 *   artifacts/hoops-stats/src/pages/billing.tsx   (FAILED_CHECKOUT_KEY resume banner)
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";
import { createClerkClient } from "@clerk/backend";

const PENDING_CHECKOUT_KEY = "stec-pending-checkout";
const FAILED_CHECKOUT_KEY = "stec-failed-checkout";

const clerkClient = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
});

type TestUser = { id: string; email: string };

async function createTestUser(tag: string): Promise<TestUser> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const email = `premium-checkout-${tag}-${suffix}+clerk_test@example.com`;
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

/** Sign in and create one player so OnboardingGate doesn't redirect to /onboarding. */
async function signInWithPlayer(
  page: Page,
  context: BrowserContext,
  email: string,
) {
  await setupClerkTestingToken({ context });
  await page.goto("/");
  await clerk.signIn({ page, emailAddress: email });

  const existing = await page.request.get("/api/players");
  const players = existing.ok() ? await existing.json() : [];
  if (players.length === 0) {
    const res = await page.request.post("/api/players", {
      data: { name: "Test Player" },
    });
    if (!res.ok()) {
      throw new Error(
        `Failed to create player: ${res.status()} ${await res.text()}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Suite 1: PendingCheckoutResumer fires checkout with tier="premium"
// ---------------------------------------------------------------------------
test.describe("PendingCheckoutResumer – Premium tier intent", () => {
  let user: TestUser;

  test.beforeAll(async () => {
    user = await createTestUser("resumer");
  });

  test.afterAll(async () => {
    await deleteTestUser(user.id);
  });

  test(
    "checkout request body contains tier=premium when PENDING_CHECKOUT_KEY encodes tier=premium",
    async ({ page, context }) => {
      await setupClerkTestingToken({ context });
      await page.goto("/");
      await clerk.signIn({ page, emailAddress: user.email });

      // Set the pending checkout intent BEFORE the app mounts on a subsequent
      // navigation so PendingCheckoutResumer picks it up.  We set it via
      // evaluate on the current page so it persists into the next load.
      await page.evaluate(
        ({ key, value }) => sessionStorage.setItem(key, value),
        {
          key: PENDING_CHECKOUT_KEY,
          value: JSON.stringify({ interval: "month", tier: "premium" }),
        },
      );

      // Intercept the checkout POST before navigating so we don't miss it.
      const checkoutRequestPromise = page.waitForRequest(
        (req) =>
          req.url().includes("/api/billing/checkout") &&
          req.method() === "POST",
        { timeout: 20000 },
      );

      // A fresh navigation triggers PendingCheckoutResumer (it runs on mount).
      await page.goto("/dashboard");

      const checkoutRequest = await checkoutRequestPromise;
      expect(checkoutRequest).toBeTruthy();

      // The request body must carry tier="premium", not "pro".
      const body = JSON.parse(checkoutRequest.postData() ?? "{}") as {
        data?: { tier?: string; interval?: string };
      };
      expect(body?.data?.tier).toBe("premium");
      expect(body?.data?.interval).toBe("month");
    },
  );
});

// ---------------------------------------------------------------------------
// Suite 2: Billing page resume banner shows Premium labels
// ---------------------------------------------------------------------------
test.describe("Billing page – Premium resume-checkout banner", () => {
  let user: TestUser;

  test.beforeAll(async () => {
    user = await createTestUser("billing");
  });

  test.afterAll(async () => {
    await deleteTestUser(user.id);
  });

  test(
    "banner shows 'Premium' text when FAILED_CHECKOUT_KEY encodes tier=premium",
    async ({ page, context }) => {
      await signInWithPlayer(page, context, user.email);

      // Inject a failed Premium checkout intent into localStorage.
      await page.evaluate(
        ({ key, value }) => localStorage.setItem(key, value),
        {
          key: FAILED_CHECKOUT_KEY,
          value: JSON.stringify({ interval: "month", tier: "premium" }),
        },
      );

      await page.goto("/billing");

      const banner = page.getByTestId("resume-checkout-banner");
      await expect(banner).toBeVisible({ timeout: 15000 });

      // The description must mention "Premium", not just "Pro".
      await expect(banner).toContainText("Premium");
      await expect(banner).not.toContainText("Pro checkout didn't complete");
    },
  );

  test(
    "resume buttons are labelled 'Try Premium' when intent tier=premium",
    async ({ page, context }) => {
      await signInWithPlayer(page, context, user.email);

      await page.evaluate(
        ({ key, value }) => localStorage.setItem(key, value),
        {
          key: FAILED_CHECKOUT_KEY,
          value: JSON.stringify({ interval: "year", tier: "premium" }),
        },
      );

      await page.goto("/billing");

      const banner = page.getByTestId("resume-checkout-banner");
      await expect(banner).toBeVisible({ timeout: 15000 });

      const monthlyBtn = page.getByTestId("button-resume-monthly");
      const yearlyBtn = page.getByTestId("button-resume-yearly");

      await expect(monthlyBtn).toContainText("Premium");
      await expect(yearlyBtn).toContainText("Premium");

      // Neither button should say "Pro" when the tier is premium.
      await expect(monthlyBtn).not.toContainText("Pro");
      await expect(yearlyBtn).not.toContainText("Pro");
    },
  );

  test(
    "clicking 'Try Premium — Monthly' sends a checkout request with tier=premium",
    async ({ page, context }) => {
      await signInWithPlayer(page, context, user.email);

      await page.evaluate(
        ({ key, value }) => localStorage.setItem(key, value),
        {
          key: FAILED_CHECKOUT_KEY,
          value: JSON.stringify({ interval: "month", tier: "premium" }),
        },
      );

      await page.goto("/billing");

      const banner = page.getByTestId("resume-checkout-banner");
      await expect(banner).toBeVisible({ timeout: 15000 });

      const monthlyBtn = page.getByTestId("button-resume-monthly");
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

      const body = JSON.parse(checkoutRequest.postData() ?? "{}") as {
        data?: { tier?: string; interval?: string };
      };
      expect(body?.data?.tier).toBe("premium");
      expect(body?.data?.interval).toBe("month");
    },
  );
});
