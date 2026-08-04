import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

export type Plan = "free" | "pro" | "premium";

export interface Entitlements {
  plan: Plan;
  status: string | null;
  currentPeriodEnd: Date | null;
  trialEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  hasSoccer: boolean;
}

// Any subscription in one of these Stripe statuses grants paid access.
// `past_due`/`unpaid`/`canceled`/`incomplete_expired` etc. do NOT grant
// access -- a failed or canceled payment must never silently keep Pro/Premium
// active. This is intentionally a small allowlist rather than a denylist so
// that new/unexpected Stripe statuses default to "not entitled".
const ACTIVE_STATUSES = new Set(["trialing", "active"]);

// The designated project owner always gets Premium access regardless of Stripe.
// Set OWNER_CLERK_EMAIL in environment variables to the owner's email.
function isOwner(email: string | null | undefined): boolean {
  const ownerEmail = process.env.OWNER_CLERK_EMAIL;
  return !!ownerEmail && !!email && email.toLowerCase() === ownerEmail.toLowerCase();
}

const OWNER_PREMIUM: Entitlements = {
  plan: "premium",
  status: "active",
  currentPeriodEnd: null,
  trialEnd: null,
  cancelAtPeriodEnd: false,
  hasSoccer: true,
};

/**
 * Returns entitlements sourced from a RevenueCat mobile subscription when there
 * is no Stripe subscription to fall back to. The value stored in
 * `users.revenue_cat_entitlement` is set by the RC webhook handler whenever a
 * purchase or cancellation event is received.
 */
function rcFallback(revenueCatEntitlement?: string | null): Entitlements {
  // The stored value can be a compound "+" string when both a base plan and
  // the soccer add-on were present in the same RC grant event, e.g.:
  //   "pro", "premium", "soccer", "pro+soccer", "premium+soccer"
  // Parse all parts so neither base plan nor add-on is silently dropped.
  const parts = new Set((revenueCatEntitlement ?? "").split("+").filter(Boolean));
  const hasSoccer = parts.has("soccer");

  if (parts.has("premium")) {
    return { plan: "premium", status: "active", currentPeriodEnd: null, trialEnd: null, cancelAtPeriodEnd: false, hasSoccer };
  }
  if (parts.has("pro")) {
    return { plan: "pro", status: "active", currentPeriodEnd: null, trialEnd: null, cancelAtPeriodEnd: false, hasSoccer };
  }
  if (hasSoccer) {
    // Soccer add-on purchased without an explicit base plan in this event.
    // The add-on requires a paid plan, so grant Pro-level access.
    return { plan: "pro", status: "active", currentPeriodEnd: null, trialEnd: null, cancelAtPeriodEnd: false, hasSoccer: true };
  }
  return { plan: "free", status: null, currentPeriodEnd: null, trialEnd: null, cancelAtPeriodEnd: false, hasSoccer: false };
}

/**
 * Derives the caller's plan from Stripe subscription data synced into the
 * `stripe.*` tables by stripe-replit-sync (webhooks are the source of truth
 * -- we never trust anything the client claims).
 *
 * Plan tier is determined by which Stripe product the active subscription
 * belongs to:
 *   - Product name contains "Premium" (case-insensitive) → "premium"
 *   - Any other active subscription → "pro"
 *   - No active subscription → "free"
 *
 * Soccer add-on: any active subscription whose product name contains "Soccer"
 * sets hasSoccer = true (independent of the base plan tier).
 *
 * Pass `email` to grant the designated project owner free permanent Premium
 * access (hasSoccer also granted).
 *
 * Pass `revenueCatEntitlement` (stored from the RC webhook) to grant access
 * when a coach subscribed via the mobile app without a Stripe subscription.
 * Stripe always takes precedence; RC is only checked when Stripe returns "free".
 */
export async function getEntitlements(
  stripeCustomerId: string | null,
  email?: string | null,
  revenueCatEntitlement?: string | null,
): Promise<Entitlements> {
  if (isOwner(email)) return OWNER_PREMIUM;

  if (!stripeCustomerId) {
    return rcFallback(revenueCatEntitlement);
  }

  // Fetch ALL active subscriptions so we can check both base plan and add-ons
  // (e.g. Basketball Pro + Soccer add-on are separate subscriptions).
  const result = await db.execute(sql`
    SELECT
      sub.status,
      sub.current_period_end,
      sub.trial_end,
      sub.cancel_at_period_end,
      prod.name AS product_name
    FROM stripe.subscriptions sub
    LEFT JOIN stripe.subscription_items si
      ON si.subscription = sub.id
      AND (si.deleted IS NULL OR si.deleted = false)
    LEFT JOIN stripe.prices pr ON pr.id = si.price
    LEFT JOIN stripe.products prod ON prod.id = pr.product
    WHERE sub.customer = ${stripeCustomerId}
    ORDER BY sub.created DESC
  `);

  type Row = {
    status: string;
    current_period_end: number | string | null;
    trial_end: number | string | null;
    cancel_at_period_end: boolean | null;
    product_name: string | null;
  };

  const rows = result.rows as Row[];

  if (rows.length === 0) {
    return rcFallback(revenueCatEntitlement);
  }

  const toDate = (value: number | string | null): Date | null => {
    if (value === null || value === undefined) return null;
    const num = typeof value === "string" ? Number(value) : value;
    return Number.isFinite(num) ? new Date(num * 1000) : null;
  };

  // Use the most recent subscription for billing dates / status display.
  const primary = rows[0];

  let plan: Plan = "free";
  let hasSoccer = false;

  for (const row of rows) {
    if (!ACTIVE_STATUSES.has(row.status)) continue;
    const name = (row.product_name ?? "").toLowerCase();
    if (name.includes("soccer")) {
      hasSoccer = true;
    } else if (name.includes("premium")) {
      plan = "premium";
    } else {
      // Any other active paid sub (Pro, etc.) grants at least Pro.
      if (plan === "free") plan = "pro";
    }
  }

  // If Stripe has subscription history for this customer but none of the
  // subscriptions are currently active (e.g. they cancelled on web), fall
  // back to the RevenueCat entitlement stored from the mobile webhook.
  // Stripe always takes precedence when it is actively paid.
  if (plan === "free") {
    const rc = rcFallback(revenueCatEntitlement);
    if (rc.plan !== "free") {
      return rc;
    }
  }

  return {
    plan,
    hasSoccer,
    status: primary.status,
    currentPeriodEnd: toDate(primary.current_period_end),
    trialEnd: toDate(primary.trial_end),
    cancelAtPeriodEnd: primary.cancel_at_period_end ?? false,
  };
}

export function isPro(entitlements: Entitlements): boolean {
  return entitlements.plan === "pro" || entitlements.plan === "premium";
}

export async function requirePro(stripeCustomerId: string | null): Promise<boolean> {
  const entitlements = await getEntitlements(stripeCustomerId);
  return isPro(entitlements);
}

export async function requirePremium(stripeCustomerId: string | null): Promise<boolean> {
  const entitlements = await getEntitlements(stripeCustomerId);
  return entitlements.plan === "premium";
}

/**
 * Convenience wrapper that accepts the full local user row so call sites
 * don't have to remember to pass `revenueCatEntitlement` explicitly.
 * Use this everywhere a `req.appUser` is available.
 */
export async function getEntitlementsForUser(appUser: {
  stripeCustomerId?: string | null;
  email?: string | null;
  revenueCatEntitlement?: string | null;
}): Promise<Entitlements> {
  return getEntitlements(
    appUser.stripeCustomerId ?? null,
    appUser.email ?? null,
    appUser.revenueCatEntitlement ?? null,
  );
}
