/**
 * RevenueCat webhook → billing status integration test
 *
 * Verifies the full chain:
 *   INITIAL_PURCHASE webhook → DB update → GET /api/billing/status returns plan:"pro"
 *   EXPIRATION webhook       → DB update → GET /api/billing/status returns plan:"free"
 *
 * The DB is replaced with a stateful in-memory mock so updates made by the
 * webhook handler are reflected when the billing status endpoint reads
 * req.appUser.revenueCatEntitlement.  No real database or RevenueCat
 * credentials are required.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";

// ---------------------------------------------------------------------------
// Stateful in-memory user — shared between the DB mock and the requireAuth
// mock so webhook writes are visible to the billing route.
// vi.hoisted() runs before vi.mock() factories, making the ref available.
// ---------------------------------------------------------------------------
const { testUserState } = vi.hoisted(() => {
  const testUserState = {
    id: 1,
    clerkUserId: "test_clerk_user_rc_001",
    email: "rc-test@example.com",
    stripeCustomerId: null as string | null,
    youtubeRefreshToken: null as string | null,
    revenueCatEntitlement: null as string | null,
    firstName: null as string | null,
    lastName: null as string | null,
    pushToken: null as string | null,
    createdAt: new Date(),
  };
  return { testUserState };
});

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any imports that trigger them.
// ---------------------------------------------------------------------------

vi.mock("@workspace/db", () => ({
  db: {
    // The webhook handler calls:
    //   db.update(usersTable).set({ revenueCatEntitlement }).where(eq(usersTable.clerkUserId, appUserId))
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((data: Partial<typeof testUserState>) => ({
        where: vi.fn().mockImplementation(async () => {
          // Apply the update to the shared in-memory user.
          Object.assign(testUserState, data);
        }),
      })),
    }),
    // The expiry handler reads the current revenueCatEntitlement before
    // surgically removing the expired part:
    //   db.select({ revenueCatEntitlement }).from(usersTable).where(...)
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation(async () => [
          { revenueCatEntitlement: testUserState.revenueCatEntitlement },
        ]),
      }),
    }),
    // getEntitlements may call db.execute for Stripe tables when stripeCustomerId
    // is non-null.  Our test user has no Stripe customer, so this should not be
    // reached, but mock it defensively.
    execute: vi.fn().mockResolvedValue({ rows: [] }),
  },
  usersTable: {
    // Drizzle column references — only need to exist as objects; the mock
    // where() above ignores the condition and operates on testUserState by key.
    clerkUserId: "clerk_user_id",
    revenueCatEntitlement: "revenue_cat_entitlement",
    id: "id",
  },
}));

vi.mock("../../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// requireAuth: inject the current testUserState snapshot so the billing route
// sees the latest revenueCatEntitlement written by the webhook.
vi.mock("../../middlewares/requireAuth", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    // Spread to capture the current state at request time.
    req.appUser = { ...testUserState };
    next();
  },
}));

// ---------------------------------------------------------------------------
// Real imports (after mocks are registered)
// ---------------------------------------------------------------------------
import { handleRevenueCatWebhook } from "../revenuecat-webhook";
import billingRouter from "../billing";
import { db } from "@workspace/db";

// ---------------------------------------------------------------------------
// Express app shared across all tests
// ---------------------------------------------------------------------------
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();

  // Webhook endpoint: raw body parsing (mirrors app.ts setup).
  app.post("/api/revenuecat/webhook", express.raw({ type: "*/*" }), handleRevenueCatWebhook);

  // Billing status endpoint: needs express.json() + the billing router.
  app.use(express.json());
  app.use("/api", billingRouter);

  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.restoreAllMocks();
});

// Reset entitlement before each test so tests are independent.
beforeEach(() => {
  testUserState.revenueCatEntitlement = null;
  testUserState.stripeCustomerId = null;
  delete process.env["REVENUECAT_WEBHOOK_SECRET"];
  delete process.env["NODE_ENV"];
  delete process.env["OWNER_CLERK_EMAIL"];
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWebhookBody(eventType: string, entitlementIds: string[] = ["pro"]): Buffer {
  return Buffer.from(
    JSON.stringify({
      event: {
        type: eventType,
        app_user_id: testUserState.clerkUserId,
        entitlement_ids: entitlementIds,
      },
    }),
    "utf8",
  );
}

async function postWebhook(body: Buffer, secret?: string): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret) headers["Authorization"] = `Bearer ${secret}`;
  return fetch(`${baseUrl}/api/revenuecat/webhook`, { method: "POST", body, headers });
}

async function getBillingStatus(): Promise<{ plan: string; status: string | null; hasSoccer: boolean }> {
  const res = await fetch(`${baseUrl}/api/billing/status`);
  expect(res.status).toBe(200);
  return res.json() as Promise<{ plan: string; status: string | null; hasSoccer: boolean }>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RevenueCat webhook → billing status", () => {
  // -------------------------------------------------------------------------
  // 1. Baseline: no purchase → plan is "free"
  // -------------------------------------------------------------------------
  it("returns plan:free before any purchase event", async () => {
    const billing = await getBillingStatus();
    expect(billing.plan).toBe("free");
  });

  // -------------------------------------------------------------------------
  // 2. INITIAL_PURCHASE with entitlement_id "pro" → plan becomes "pro"
  // -------------------------------------------------------------------------
  it("grants plan:pro after INITIAL_PURCHASE webhook with pro entitlement", async () => {
    const res = await postWebhook(makeWebhookBody("INITIAL_PURCHASE", ["pro"]));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { received: boolean };
    expect(body.received).toBe(true);

    // The in-memory user should now carry the entitlement.
    expect(testUserState.revenueCatEntitlement).toBe("pro");

    // Billing status must reflect the updated entitlement.
    const billing = await getBillingStatus();
    expect(billing.plan).toBe("pro");
  });

  // -------------------------------------------------------------------------
  // 3. EXPIRATION → entitlement is cleared → plan reverts to "free"
  // -------------------------------------------------------------------------
  it("reverts to plan:free after EXPIRATION webhook", async () => {
    // Set up a pre-existing pro entitlement (as if a prior purchase occurred).
    testUserState.revenueCatEntitlement = "pro";

    // Sanity: billing status is pro before expiration.
    const before = await getBillingStatus();
    expect(before.plan).toBe("pro");

    // Fire EXPIRATION.
    const res = await postWebhook(makeWebhookBody("EXPIRATION"));
    expect(res.status).toBe(200);
    expect(testUserState.revenueCatEntitlement).toBeNull();

    const after = await getBillingStatus();
    expect(after.plan).toBe("free");
  });

  // -------------------------------------------------------------------------
  // 4. Full round-trip: purchase → active → expire → free
  // -------------------------------------------------------------------------
  it("full round-trip: INITIAL_PURCHASE then EXPIRATION reverts to free", async () => {
    // Step 1: purchase
    const purchaseRes = await postWebhook(makeWebhookBody("INITIAL_PURCHASE", ["pro"]));
    expect(purchaseRes.status).toBe(200);
    expect(testUserState.revenueCatEntitlement).toBe("pro");

    const afterPurchase = await getBillingStatus();
    expect(afterPurchase.plan).toBe("pro");

    // Step 2: expire
    const expireRes = await postWebhook(makeWebhookBody("EXPIRATION"));
    expect(expireRes.status).toBe(200);
    expect(testUserState.revenueCatEntitlement).toBeNull();

    const afterExpiry = await getBillingStatus();
    expect(afterExpiry.plan).toBe("free");
  });

  // -------------------------------------------------------------------------
  // 5. RENEWAL keeps plan:pro
  // -------------------------------------------------------------------------
  it("keeps plan:pro after RENEWAL webhook", async () => {
    testUserState.revenueCatEntitlement = "pro";

    const res = await postWebhook(makeWebhookBody("RENEWAL", ["pro"]));
    expect(res.status).toBe(200);
    expect(testUserState.revenueCatEntitlement).toBe("pro");

    const billing = await getBillingStatus();
    expect(billing.plan).toBe("pro");
  });

  // -------------------------------------------------------------------------
  // 6. CANCELLATION does NOT clear entitlement (access until period end)
  // -------------------------------------------------------------------------
  it("keeps plan:pro after CANCELLATION (access retained until period end)", async () => {
    testUserState.revenueCatEntitlement = "pro";

    const res = await postWebhook(makeWebhookBody("CANCELLATION"));
    expect(res.status).toBe(200);

    // entitlement must NOT be cleared by a cancellation event
    expect(testUserState.revenueCatEntitlement).toBe("pro");

    const billing = await getBillingStatus();
    expect(billing.plan).toBe("pro");
  });

  // -------------------------------------------------------------------------
  // 7. BILLING_ISSUE clears entitlement (same as EXPIRATION)
  // -------------------------------------------------------------------------
  it("reverts to plan:free after BILLING_ISSUE webhook", async () => {
    testUserState.revenueCatEntitlement = "pro";

    const res = await postWebhook(makeWebhookBody("BILLING_ISSUE"));
    expect(res.status).toBe(200);
    expect(testUserState.revenueCatEntitlement).toBeNull();

    const billing = await getBillingStatus();
    expect(billing.plan).toBe("free");
  });

  // -------------------------------------------------------------------------
  // 8. Webhook secret validation — wrong secret → 401
  // -------------------------------------------------------------------------
  it("rejects webhook with wrong Authorization header when secret is set", async () => {
    process.env["REVENUECAT_WEBHOOK_SECRET"] = "correct-secret";

    const res = await postWebhook(makeWebhookBody("INITIAL_PURCHASE", ["pro"]), "wrong-secret");
    expect(res.status).toBe(401);

    // Entitlement must not have been updated.
    expect(testUserState.revenueCatEntitlement).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 9. Webhook secret validation — correct secret → 200
  // -------------------------------------------------------------------------
  it("accepts webhook with correct Authorization header", async () => {
    process.env["REVENUECAT_WEBHOOK_SECRET"] = "correct-secret";

    const res = await postWebhook(makeWebhookBody("INITIAL_PURCHASE", ["pro"]), "correct-secret");
    expect(res.status).toBe(200);
    expect(testUserState.revenueCatEntitlement).toBe("pro");

    const billing = await getBillingStatus();
    expect(billing.plan).toBe("pro");
  });

  // -------------------------------------------------------------------------
  // 10. Unknown entitlement ID → no grant (no-op, returns 200)
  // -------------------------------------------------------------------------
  it("does not grant access for an unrecognised entitlement ID", async () => {
    const res = await postWebhook(makeWebhookBody("INITIAL_PURCHASE", ["basketball_plus"]));
    expect(res.status).toBe(200);

    // entitlement must remain null — unknown IDs are skipped
    expect(testUserState.revenueCatEntitlement).toBeNull();

    const billing = await getBillingStatus();
    expect(billing.plan).toBe("free");
  });

  // -------------------------------------------------------------------------
  // 11. premium entitlement_id → plan becomes "premium"
  // -------------------------------------------------------------------------
  it("grants plan:premium after INITIAL_PURCHASE with premium entitlement", async () => {
    const res = await postWebhook(makeWebhookBody("INITIAL_PURCHASE", ["premium"]));
    expect(res.status).toBe(200);
    expect(testUserState.revenueCatEntitlement).toBe("premium");

    const billing = await getBillingStatus();
    expect(billing.plan).toBe("premium");
  });

  // -------------------------------------------------------------------------
  // 12. Stale-session guard: entitlement revoked mid-session must NOT be
  //     honoured on the very next request.
  //
  //     requireAuth re-reads the users row from the DB on every request, so
  //     there is no session-level cache that could keep a revoked entitlement
  //     alive. This test verifies the full chain:
  //       1. User is "pro" (simulating an active mobile subscription).
  //       2. An EXPIRATION webhook arrives and clears revenueCatEntitlement.
  //       3. The immediately-following billing-status request — representing
  //          the first request the user makes after the webhook — returns
  //          plan:"free", not the stale plan:"pro".
  // -------------------------------------------------------------------------
  it("does not honour a revoked RC entitlement on the next request after the webhook fires", async () => {
    // Simulate an active mobile subscriber mid-session.
    testUserState.revenueCatEntitlement = "pro";

    // The current request (e.g. a page load) still sees "pro".
    const beforeWebhook = await getBillingStatus();
    expect(beforeWebhook.plan).toBe("pro");

    // RC sends an EXPIRATION event — subscription has ended.
    const webhookRes = await postWebhook(makeWebhookBody("EXPIRATION"));
    expect(webhookRes.status).toBe(200);

    // The DB row is now cleared (requireAuth re-reads the DB every request).
    expect(testUserState.revenueCatEntitlement).toBeNull();

    // The very next request — even within the same browser session — must
    // reflect the revocation immediately.  No server restart required.
    const afterWebhook = await getBillingStatus();
    expect(afterWebhook.plan).toBe("free");
  });

  // -------------------------------------------------------------------------
  // Partial-expiry: four combinations where one of two active entitlements
  // expires and the other must survive unchanged.
  // -------------------------------------------------------------------------

  // 13. Pro+Soccer — soccer expires → pro survives
  it("partial-expiry: soccer EXPIRATION on pro+soccer leaves plan:pro with no soccer", async () => {
    testUserState.revenueCatEntitlement = "pro+soccer";

    const res = await postWebhook(makeWebhookBody("EXPIRATION", ["soccer"]));
    expect(res.status).toBe(200);

    // "soccer" removed, "pro" kept.
    expect(testUserState.revenueCatEntitlement).toBe("pro");

    const billing = await getBillingStatus();
    expect(billing.plan).toBe("pro");
    expect(billing.hasSoccer).toBe(false);
  });

  // 14. Pro+Soccer — pro expires → soccer survives (base plan drops to free
  //     when resolved, but the stored column retains "soccer" so a separate
  //     re-grant of pro can restore full access without a new soccer purchase).
  it("partial-expiry: pro EXPIRATION on pro+soccer leaves only soccer in column", async () => {
    testUserState.revenueCatEntitlement = "pro+soccer";

    const res = await postWebhook(makeWebhookBody("EXPIRATION", ["pro"]));
    expect(res.status).toBe(200);

    // "pro" removed, "soccer" kept in column.
    expect(testUserState.revenueCatEntitlement).toBe("soccer");
  });

  // 15. Premium+Soccer — soccer expires → premium survives
  it("partial-expiry: soccer EXPIRATION on premium+soccer leaves plan:premium with no soccer", async () => {
    testUserState.revenueCatEntitlement = "premium+soccer";

    const res = await postWebhook(makeWebhookBody("EXPIRATION", ["soccer"]));
    expect(res.status).toBe(200);

    expect(testUserState.revenueCatEntitlement).toBe("premium");

    const billing = await getBillingStatus();
    expect(billing.plan).toBe("premium");
    expect(billing.hasSoccer).toBe(false);
  });

  // 16. Premium+Soccer — premium expires → soccer survives in column
  it("partial-expiry: premium EXPIRATION on premium+soccer leaves only soccer in column", async () => {
    testUserState.revenueCatEntitlement = "premium+soccer";

    const res = await postWebhook(makeWebhookBody("EXPIRATION", ["premium"]));
    expect(res.status).toBe(200);

    // "premium" removed, "soccer" kept.
    expect(testUserState.revenueCatEntitlement).toBe("soccer");
  });
});

// ---------------------------------------------------------------------------
// Soccer add-on integration tests
//
// These verify the full chain for the soccer add-on specifically:
//   INITIAL_PURCHASE webhook with entitlement_id "soccer"
//     → DB updated (revenueCatEntitlement = "soccer" or "pro+soccer" etc.)
//     → GET /api/billing/status returns hasSoccer:true
//
// Two paths are covered:
//   A. Pure RC (no Stripe customer) — stripeCustomerId is null.
//   B. Cancelled Stripe sub (RC fallback) — customer exists but all subs are
//      cancelled, so getEntitlements falls back to the RC column.
// ---------------------------------------------------------------------------

describe("Soccer add-on → billing status: pure RC path (no Stripe customer)", () => {
  // -------------------------------------------------------------------------
  // 1. Solo soccer entitlement — the add-on alone implies Pro-level access
  // -------------------------------------------------------------------------
  it("returns hasSoccer:true and plan:pro after INITIAL_PURCHASE with entitlement_id ['soccer']", async () => {
    // stripeCustomerId is null (set in beforeEach) — pure RC path.
    const res = await postWebhook(makeWebhookBody("INITIAL_PURCHASE", ["soccer"]));
    expect(res.status).toBe(200);

    // Webhook must store "soccer" in the DB column.
    expect(testUserState.revenueCatEntitlement).toBe("soccer");

    // Billing status must surface the add-on.
    const billing = await getBillingStatus();
    expect(billing.hasSoccer).toBe(true);
    expect(billing.plan).toBe("pro");
    expect(billing.status).toBe("active");
  });

  // -------------------------------------------------------------------------
  // 2. Compound event: base plan + soccer in the same entitlement_ids array
  // -------------------------------------------------------------------------
  it("returns hasSoccer:true and plan:pro for INITIAL_PURCHASE with ['pro', 'soccer']", async () => {
    const res = await postWebhook(makeWebhookBody("INITIAL_PURCHASE", ["pro", "soccer"]));
    expect(res.status).toBe(200);

    // Compound value written to DB.
    expect(testUserState.revenueCatEntitlement).toBe("pro+soccer");

    const billing = await getBillingStatus();
    expect(billing.hasSoccer).toBe(true);
    expect(billing.plan).toBe("pro");
  });

  it("returns hasSoccer:true and plan:premium for INITIAL_PURCHASE with ['premium', 'soccer']", async () => {
    const res = await postWebhook(makeWebhookBody("INITIAL_PURCHASE", ["premium", "soccer"]));
    expect(res.status).toBe(200);

    expect(testUserState.revenueCatEntitlement).toBe("premium+soccer");

    const billing = await getBillingStatus();
    expect(billing.hasSoccer).toBe(true);
    expect(billing.plan).toBe("premium");
  });

  // -------------------------------------------------------------------------
  // 3. Soccer without a base plan in a RENEWAL event
  // -------------------------------------------------------------------------
  it("returns hasSoccer:true after RENEWAL with ['soccer']", async () => {
    testUserState.revenueCatEntitlement = "soccer"; // pre-existing from prior purchase

    const res = await postWebhook(makeWebhookBody("RENEWAL", ["soccer"]));
    expect(res.status).toBe(200);
    expect(testUserState.revenueCatEntitlement).toBe("soccer");

    const billing = await getBillingStatus();
    expect(billing.hasSoccer).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 4. EXPIRATION clears soccer too — hasSoccer must become false
  // -------------------------------------------------------------------------
  it("clears hasSoccer after EXPIRATION (no-soccer fallback to free)", async () => {
    testUserState.revenueCatEntitlement = "soccer";

    // Confirm soccer is visible before the expiration.
    const before = await getBillingStatus();
    expect(before.hasSoccer).toBe(true);

    // Pass no entitlement_ids so the handler takes the "clear everything" path —
    // semantically correct when a subscriber's entire access ends at once.
    const res = await postWebhook(makeWebhookBody("EXPIRATION", []));
    expect(res.status).toBe(200);
    expect(testUserState.revenueCatEntitlement).toBeNull();

    const after = await getBillingStatus();
    expect(after.hasSoccer).toBe(false);
    expect(after.plan).toBe("free");
  });

  // -------------------------------------------------------------------------
  // 5. CANCELLATION retains soccer until period end
  // -------------------------------------------------------------------------
  it("keeps hasSoccer:true after CANCELLATION (access retained until period end)", async () => {
    testUserState.revenueCatEntitlement = "pro+soccer";

    const res = await postWebhook(makeWebhookBody("CANCELLATION"));
    expect(res.status).toBe(200);

    // CANCELLATION must NOT clear the entitlement.
    expect(testUserState.revenueCatEntitlement).toBe("pro+soccer");

    const billing = await getBillingStatus();
    expect(billing.hasSoccer).toBe(true);
    expect(billing.plan).toBe("pro");
  });

  // -------------------------------------------------------------------------
  // 6. Pro purchase without soccer → hasSoccer must remain false
  // -------------------------------------------------------------------------
  it("returns hasSoccer:false when only ['pro'] is purchased (no soccer add-on)", async () => {
    const res = await postWebhook(makeWebhookBody("INITIAL_PURCHASE", ["pro"]));
    expect(res.status).toBe(200);

    const billing = await getBillingStatus();
    expect(billing.hasSoccer).toBe(false);
    expect(billing.plan).toBe("pro");
  });
});

describe("Soccer add-on → billing status: cancelled Stripe sub path (RC fallback)", () => {
  // When a Stripe customer exists but all subscriptions are cancelled,
  // getEntitlements falls through to rcFallback(revenueCatEntitlement).
  // A prior web cancellation must not erase a valid mobile soccer purchase.

  beforeEach(() => {
    // Give the test user a Stripe customer ID so getEntitlements hits db.execute.
    testUserState.stripeCustomerId = "cus_test_cancelled_001";
  });

  // Helper: make db.execute return a single cancelled subscription row.
  function stubCancelledStripeRow() {
    vi.mocked(db.execute).mockResolvedValueOnce({
      rows: [
        {
          status: "canceled",
          current_period_end: 1700000000,
          trial_end: null,
          cancel_at_period_end: false,
          product_name: "Basketball Pro",
        },
      ],
    } as unknown as Awaited<ReturnType<typeof db.execute>>);
  }

  // -------------------------------------------------------------------------
  // 1. Soccer purchase → cancelled Stripe → hasSoccer:true via RC fallback
  // -------------------------------------------------------------------------
  it("returns hasSoccer:true after soccer INITIAL_PURCHASE when Stripe sub is cancelled", async () => {
    // Post the RC soccer purchase webhook first (sets the DB column).
    const webhookRes = await postWebhook(makeWebhookBody("INITIAL_PURCHASE", ["soccer"]));
    expect(webhookRes.status).toBe(200);
    expect(testUserState.revenueCatEntitlement).toBe("soccer");

    // Stripe query will return a cancelled row — RC fallback activates.
    stubCancelledStripeRow();

    const billing = await getBillingStatus();
    expect(billing.hasSoccer).toBe(true);
    expect(billing.plan).toBe("pro");
  });

  // -------------------------------------------------------------------------
  // 2. Compound (pro+soccer) purchase → cancelled Stripe → hasSoccer:true
  // -------------------------------------------------------------------------
  it("returns hasSoccer:true for pro+soccer when Stripe sub is cancelled", async () => {
    const webhookRes = await postWebhook(makeWebhookBody("INITIAL_PURCHASE", ["pro", "soccer"]));
    expect(webhookRes.status).toBe(200);
    expect(testUserState.revenueCatEntitlement).toBe("pro+soccer");

    stubCancelledStripeRow();

    const billing = await getBillingStatus();
    expect(billing.hasSoccer).toBe(true);
    expect(billing.plan).toBe("pro");
  });

  // -------------------------------------------------------------------------
  // 3. No RC soccer, cancelled Stripe → hasSoccer must be false (no phantom access)
  // -------------------------------------------------------------------------
  it("returns hasSoccer:false when Stripe is cancelled and no RC soccer entitlement", async () => {
    // Only pro RC entitlement — no soccer.
    const webhookRes = await postWebhook(makeWebhookBody("INITIAL_PURCHASE", ["pro"]));
    expect(webhookRes.status).toBe(200);
    expect(testUserState.revenueCatEntitlement).toBe("pro");

    stubCancelledStripeRow();

    const billing = await getBillingStatus();
    expect(billing.hasSoccer).toBe(false);
    expect(billing.plan).toBe("pro");
  });

  // -------------------------------------------------------------------------
  // 4. Soccer expired via RC + cancelled Stripe → hasSoccer false (no double-grant)
  // -------------------------------------------------------------------------
  it("returns hasSoccer:false after RC EXPIRATION even when Stripe sub is also cancelled", async () => {
    // Start with soccer entitlement.
    testUserState.revenueCatEntitlement = "soccer";

    // RC subscription expires — no entitlement_ids so the handler clears everything.
    const expireRes = await postWebhook(makeWebhookBody("EXPIRATION", []));
    expect(expireRes.status).toBe(200);
    expect(testUserState.revenueCatEntitlement).toBeNull();

    stubCancelledStripeRow();

    const billing = await getBillingStatus();
    expect(billing.hasSoccer).toBe(false);
    expect(billing.plan).toBe("free");
  });
});
