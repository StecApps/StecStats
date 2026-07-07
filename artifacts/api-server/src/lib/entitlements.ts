import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

export type Plan = "free" | "pro" | "premium";

export interface Entitlements {
  plan: Plan;
  status: string | null;
  currentPeriodEnd: Date | null;
  trialEnd: Date | null;
  cancelAtPeriodEnd: boolean;
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
};

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
 * Pass `email` to grant the designated project owner free permanent Premium
 * access.
 */
export async function getEntitlements(
  stripeCustomerId: string | null,
  email?: string | null,
): Promise<Entitlements> {
  if (isOwner(email)) return OWNER_PREMIUM;

  if (!stripeCustomerId) {
    return { plan: "free", status: null, currentPeriodEnd: null, trialEnd: null, cancelAtPeriodEnd: false };
  }

  // Join subscription → subscription_items → prices → products so we can
  // determine which tier (Pro vs Premium) the subscriber is on.
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
    LIMIT 1
  `);

  const row = result.rows[0] as
    | {
        status: string;
        current_period_end: number | string | null;
        trial_end: number | string | null;
        cancel_at_period_end: boolean | null;
        product_name: string | null;
      }
    | undefined;

  if (!row) {
    return { plan: "free", status: null, currentPeriodEnd: null, trialEnd: null, cancelAtPeriodEnd: false };
  }

  const toDate = (value: number | string | null): Date | null => {
    if (value === null || value === undefined) return null;
    const num = typeof value === "string" ? Number(value) : value;
    return Number.isFinite(num) ? new Date(num * 1000) : null;
  };

  let plan: Plan = "free";
  if (ACTIVE_STATUSES.has(row.status)) {
    const productName = (row.product_name ?? "").toLowerCase();
    plan = productName.includes("premium") ? "premium" : "pro";
  }

  return {
    plan,
    status: row.status,
    currentPeriodEnd: toDate(row.current_period_end),
    trialEnd: toDate(row.trial_end),
    cancelAtPeriodEnd: row.cancel_at_period_end ?? false,
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
