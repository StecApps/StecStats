/**
 * Unit tests for getEntitlements() in lib/entitlements.ts
 *
 * Covers:
 *   - Stripe-active + RC-stale combinations: Stripe always wins when it has an
 *     active paid subscription, regardless of what RC says.
 *   - RC-only path: when there is no Stripe customer, RC entitlement is the
 *     sole source of truth.
 *   - Stripe customer exists but no active subs: RC fallback kicks in.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// DB mock — must be declared before importing the module under test so that
// vi.mock() is hoisted and the real @workspace/db is never loaded.
// ---------------------------------------------------------------------------

// We need a mutable ref to control what db.execute returns per-test.
const { mockExecuteResult } = vi.hoisted(() => ({
  mockExecuteResult: { rows: [] as Record<string, unknown>[] },
}));

vi.mock("@workspace/db", () => ({
  db: {
    execute: vi.fn().mockImplementation(async () => ({ rows: mockExecuteResult.rows })),
  },
  sql: vi.fn(), // unused here; imported by entitlements.ts but we mock db.execute
}));

// Suppress logger noise in test output.
vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Real import (after mocks are registered)
// ---------------------------------------------------------------------------
import { getEntitlements } from "../entitlements";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type StripeRow = {
  status: string;
  current_period_end: number | null;
  trial_end: number | null;
  cancel_at_period_end: boolean;
  product_name: string | null;
};

function makeRow(overrides: Partial<StripeRow> = {}): StripeRow {
  return {
    status: "active",
    current_period_end: 9999999999,
    trial_end: null,
    cancel_at_period_end: false,
    product_name: "Basketball Pro",
    ...overrides,
  };
}

beforeEach(() => {
  // Reset the mock result and environment for each test.
  mockExecuteResult.rows = [];
  delete process.env["OWNER_CLERK_EMAIL"];
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getEntitlements() — Stripe active + RC stale: Stripe wins", () => {
  it("returns 'pro' when Stripe is active-pro and RC says 'premium'", async () => {
    // Stripe has an active Pro sub; RC claims premium (stale/over-grant scenario).
    mockExecuteResult.rows = [makeRow({ product_name: "Basketball Pro" })];

    const result = await getEntitlements("cus_stripe123", null, "premium");

    expect(result.plan).toBe("pro");
    expect(result.status).toBe("active");
  });

  it("returns 'premium' when Stripe is active-premium and RC says 'pro'", async () => {
    // Stripe has an active Premium sub; RC says a lower tier.
    mockExecuteResult.rows = [makeRow({ product_name: "Basketball Premium" })];

    const result = await getEntitlements("cus_stripe123", null, "pro");

    expect(result.plan).toBe("premium");
    expect(result.status).toBe("active");
  });

  it("returns 'pro' when Stripe is active-pro and RC is null", async () => {
    mockExecuteResult.rows = [makeRow({ product_name: "Basketball Pro" })];

    const result = await getEntitlements("cus_stripe123", null, null);

    expect(result.plan).toBe("pro");
  });

  it("returns 'premium' when Stripe is active-premium and RC is null", async () => {
    mockExecuteResult.rows = [makeRow({ product_name: "Basketball Premium" })];

    const result = await getEntitlements("cus_stripe123", null, null);

    expect(result.plan).toBe("premium");
  });

  it("returns 'premium' when Stripe has both Pro and Premium subs and RC says 'pro'", async () => {
    // Multiple active subscriptions — the Premium one should set the tier.
    mockExecuteResult.rows = [
      makeRow({ product_name: "Basketball Pro" }),
      makeRow({ product_name: "Basketball Premium" }),
    ];

    const result = await getEntitlements("cus_stripe123", null, "pro");

    expect(result.plan).toBe("premium");
  });

  it("does not elevate plan from 'pro' to 'premium' via RC when Stripe is pro-active", async () => {
    // Explicit guard: RC must NEVER upgrade a Stripe-determined tier.
    mockExecuteResult.rows = [makeRow({ product_name: "Basketball Pro" })];

    const result = await getEntitlements("cus_stripe123", null, "premium");

    // Stripe says "pro" — that's the ceiling; RC cannot push it to "premium".
    expect(result.plan).toBe("pro");
    expect(result.plan).not.toBe("premium");
  });
});

describe("getEntitlements() — RC-only path (no Stripe customer)", () => {
  it("returns plan:'pro' from RC when there is no Stripe customer", async () => {
    const result = await getEntitlements(null, null, "pro");

    expect(result.plan).toBe("pro");
    expect(result.status).toBe("active");
  });

  it("returns plan:'premium' from RC when there is no Stripe customer", async () => {
    const result = await getEntitlements(null, null, "premium");

    expect(result.plan).toBe("premium");
    expect(result.status).toBe("active");
  });

  it("returns plan:'free' when there is no Stripe customer and RC entitlement is null", async () => {
    const result = await getEntitlements(null, null, null);

    expect(result.plan).toBe("free");
    expect(result.status).toBeNull();
  });

  it("returns plan:'free' when there is no Stripe customer and RC entitlement is unrecognised", async () => {
    // Unknown/stale entitlement strings should not grant access.
    const result = await getEntitlements(null, null, "basketball_plus");

    expect(result.plan).toBe("free");
  });
});

describe("getEntitlements() — Stripe customer exists but all subs cancelled", () => {
  it("falls back to RC when Stripe customer has only cancelled subscriptions", async () => {
    // Stripe has history but no active subs → RC is the source of truth.
    mockExecuteResult.rows = [makeRow({ status: "canceled" })];

    const result = await getEntitlements("cus_stripe123", null, "pro");

    expect(result.plan).toBe("pro");
  });

  it("falls back to RC:premium when Stripe has only past_due subs", async () => {
    mockExecuteResult.rows = [makeRow({ status: "past_due" })];

    const result = await getEntitlements("cus_stripe123", null, "premium");

    expect(result.plan).toBe("premium");
  });

  it("returns 'free' when Stripe has only cancelled subs and RC is null", async () => {
    mockExecuteResult.rows = [makeRow({ status: "canceled" })];

    const result = await getEntitlements("cus_stripe123", null, null);

    expect(result.plan).toBe("free");
  });

  it("returns 'free' when Stripe has no subscription rows and RC is null", async () => {
    // Empty rows — customer exists in Stripe but no subscription records at all.
    mockExecuteResult.rows = [];

    const result = await getEntitlements("cus_stripe123", null, null);

    expect(result.plan).toBe("free");
  });
});

describe("getEntitlements() — RC soccer add-on (no Stripe customer)", () => {
  it("returns hasSoccer:true and plan:'pro' when RC entitlement is 'soccer'", async () => {
    const result = await getEntitlements(null, null, "soccer");

    expect(result.hasSoccer).toBe(true);
    expect(result.plan).toBe("pro");
    expect(result.status).toBe("active");
  });

  it("returns hasSoccer:false when RC entitlement is 'pro' (no soccer add-on)", async () => {
    const result = await getEntitlements(null, null, "pro");

    expect(result.hasSoccer).toBe(false);
    expect(result.plan).toBe("pro");
  });

  it("returns hasSoccer:false when RC entitlement is 'premium' (no soccer add-on)", async () => {
    const result = await getEntitlements(null, null, "premium");

    expect(result.hasSoccer).toBe(false);
    expect(result.plan).toBe("premium");
  });

  // Compound values written by the webhook when both base plan and soccer
  // were present in the same RC grant event (e.g. entitlement_ids: ["pro","soccer"]).
  it("returns hasSoccer:true and plan:'pro' for compound 'pro+soccer'", async () => {
    const result = await getEntitlements(null, null, "pro+soccer");

    expect(result.hasSoccer).toBe(true);
    expect(result.plan).toBe("pro");
    expect(result.status).toBe("active");
  });

  it("returns hasSoccer:true and plan:'premium' for compound 'premium+soccer'", async () => {
    const result = await getEntitlements(null, null, "premium+soccer");

    expect(result.hasSoccer).toBe(true);
    expect(result.plan).toBe("premium");
    expect(result.status).toBe("active");
  });

  it("is order-independent: 'soccer+pro' and 'pro+soccer' both give hasSoccer:true plan:'pro'", async () => {
    const a = await getEntitlements(null, null, "soccer+pro");
    const b = await getEntitlements(null, null, "pro+soccer");

    expect(a.hasSoccer).toBe(true);
    expect(a.plan).toBe("pro");
    expect(b.hasSoccer).toBe(true);
    expect(b.plan).toBe("pro");
  });
});

describe("getEntitlements() — RC soccer add-on with Stripe customer", () => {
  it("uses Stripe's hasSoccer when Stripe has an active soccer product (RC 'soccer' is irrelevant)", async () => {
    // Stripe has a dedicated Soccer add-on product; RC value should be ignored.
    mockExecuteResult.rows = [
      makeRow({ product_name: "Basketball Pro" }),
      makeRow({ product_name: "Soccer Add-on" }),
    ];

    const result = await getEntitlements("cus_stripe123", null, "soccer");

    expect(result.hasSoccer).toBe(true);
    expect(result.plan).toBe("pro");
  });

  it("falls back to RC 'soccer' when Stripe customer has no active subscriptions", async () => {
    // Stripe customer exists but all subs are cancelled; RC is the source of truth.
    mockExecuteResult.rows = [makeRow({ status: "canceled", product_name: "Basketball Pro" })];

    const result = await getEntitlements("cus_stripe123", null, "soccer");

    expect(result.hasSoccer).toBe(true);
    expect(result.plan).toBe("pro");
  });

  it("Stripe active Pro sub does NOT pick up hasSoccer from RC 'soccer'", async () => {
    // Stripe has an active Pro sub but no soccer product; RC 'soccer' must not
    // inject hasSoccer when Stripe is the active source of truth.
    mockExecuteResult.rows = [makeRow({ product_name: "Basketball Pro" })];

    const result = await getEntitlements("cus_stripe123", null, "soccer");

    expect(result.hasSoccer).toBe(false);
    expect(result.plan).toBe("pro");
  });
});

describe("getEntitlements() — owner bypass", () => {
  it("always returns 'premium' for the designated owner regardless of Stripe/RC", async () => {
    process.env["OWNER_CLERK_EMAIL"] = "owner@example.com";
    // Even with no Stripe customer and no RC entitlement, owner gets premium.
    const result = await getEntitlements(null, "owner@example.com", null);

    expect(result.plan).toBe("premium");
  });

  it("is case-insensitive for the owner email check", async () => {
    process.env["OWNER_CLERK_EMAIL"] = "Owner@Example.com";

    const result = await getEntitlements(null, "owner@example.com", null);

    expect(result.plan).toBe("premium");
  });
});
