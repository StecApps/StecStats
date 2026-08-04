/**
 * E2E regression test: post-sign-up checkout redirect sends correct tier to Stripe
 *
 * When an unauthenticated visitor clicks "Start Free Trial" on the pricing page,
 * the intent (interval + tier) is stored in sessionStorage under PENDING_CHECKOUT_KEY.
 * After sign-up the PendingCheckoutResumer fires on mount, reads the intent,
 * clears the key, and auto-triggers Stripe Checkout with the correct parameters.
 *
 * Guards:
 *  1. Pro monthly intent → checkout request carries tier="pro", interval="month"
 *  2. Pro annual intent  → checkout request carries tier="pro", interval="year"
 *  3. sessionStorage key is cleared after the checkout fires (not re-triggered on back-nav)
 *
 * Relevant files:
 *   artifacts/hoops-stats/src/pages/pricing.tsx  (PENDING_CHECKOUT_KEY, encodeCheckoutIntent, decodeCheckoutIntent)
 *   artifacts/hoops-stats/src/App.tsx             (PendingCheckoutResumer)
 */

import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";
import { createClerkClient } from "@clerk/backend";

const PENDING_CHECKOUT_KEY = "stec-pending-checkout";

const clerkClient = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
});

type TestUser = { id: string; email: string };

async function createTestUser(tag: string): Promise<TestUser> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const email = `post-signup-checkout-${tag}-${suffix}+clerk_test@example.com`;
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

/**
 * Sign in and create one player so OnboardingGate passes and /billing is reachable.
 */
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

test.describe("Post-sign-up checkout redirect – Pro monthly", () => {
  let user: TestUser;

  test.beforeAll(async () => {
    user = await createTestUser("pro-month");
  });

  test.afterAll(async () => {
    await deleteTestUser(user.id);
  });

  test(
    "checkout request carries tier=pro and interval=month",
    async ({ page, context }) => {
      await signInWithPlayer(page, context, user.email);

      // Simulate the visitor having clicked "Start Free Trial" (monthly, pro)
      // on the pricing page before sign-up.
      await page.evaluate(
        ({ key, value }) => sessionStorage.setItem(key, value),
        {
          key: PENDING_CHECKOUT_KEY,
          value: JSON.stringify({ interval: "month", tier: "pro" }),
        },
      );

      // Intercept the checkout POST before navigating so we don't miss it.
      const checkoutRequestPromise = page.waitForRequest(
        (req) =>
          req.url().includes("/api/billing/checkout") &&
          req.method() === "POST",
        { timeout: 20000 },
      );

      // Navigate to /billing — PendingCheckoutResumer fires on mount and picks
      // up the pending intent, clearing it and triggering Stripe Checkout.
      await page.goto("/billing");

      const checkoutRequest = await checkoutRequestPromise;
      expect(checkoutRequest).toBeTruthy();

      const body = JSON.parse(checkoutRequest.postData() ?? "{}") as {
        data?: { tier?: string; interval?: string };
      };
      expect(body?.data?.tier).toBe("pro");
      expect(body?.data?.interval).toBe("month");
    },
  );
});

test.describe("Post-sign-up checkout redirect – Pro annual", () => {
  let user: TestUser;

  test.beforeAll(async () => {
    user = await createTestUser("pro-year");
  });

  test.afterAll(async () => {
    await deleteTestUser(user.id);
  });

  test(
    "checkout request carries tier=pro and interval=year",
    async ({ page, context }) => {
      await signInWithPlayer(page, context, user.email);

      await page.evaluate(
        ({ key, value }) => sessionStorage.setItem(key, value),
        {
          key: PENDING_CHECKOUT_KEY,
          value: JSON.stringify({ interval: "year", tier: "pro" }),
        },
      );

      const checkoutRequestPromise = page.waitForRequest(
        (req) =>
          req.url().includes("/api/billing/checkout") &&
          req.method() === "POST",
        { timeout: 20000 },
      );

      await page.goto("/billing");

      const checkoutRequest = await checkoutRequestPromise;
      expect(checkoutRequest).toBeTruthy();

      const body = JSON.parse(checkoutRequest.postData() ?? "{}") as {
        data?: { tier?: string; interval?: string };
      };
      expect(body?.data?.tier).toBe("pro");
      expect(body?.data?.interval).toBe("year");
    },
  );
});

test.describe("Post-sign-up checkout redirect – sessionStorage cleared", () => {
  let user: TestUser;

  test.beforeAll(async () => {
    user = await createTestUser("session-clear");
  });

  test.afterAll(async () => {
    await deleteTestUser(user.id);
  });

  test(
    "PENDING_CHECKOUT_KEY is removed from sessionStorage after checkout fires",
    async ({ page, context }) => {
      await signInWithPlayer(page, context, user.email);

      await page.evaluate(
        ({ key, value }) => sessionStorage.setItem(key, value),
        {
          key: PENDING_CHECKOUT_KEY,
          value: JSON.stringify({ interval: "month", tier: "pro" }),
        },
      );

      // Wait for checkout to fire before reading sessionStorage.
      await Promise.all([
        page.waitForRequest(
          (req) =>
            req.url().includes("/api/billing/checkout") &&
            req.method() === "POST",
          { timeout: 20000 },
        ),
        page.goto("/billing"),
      ]);

      // Allow the synchronous removal (which happens before the fetch) to settle.
      await page.waitForTimeout(500);

      const storedValue = await page.evaluate(
        ({ key }) => sessionStorage.getItem(key),
        { key: PENDING_CHECKOUT_KEY },
      );
      expect(storedValue).toBeNull();
    },
  );
});
