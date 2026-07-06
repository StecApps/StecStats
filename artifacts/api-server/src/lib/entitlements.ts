import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

export type Plan = "free" | "pro";

export interface Entitlements {
  plan: Plan;
  status: string | null;
  currentPeriodEnd: Date | null;
  trialEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

// Any subscription in one of these Stripe statuses grants Pro access.
// `past_due`/`unpaid`/`canceled`/`incomplete_expired` etc. do NOT grant
// access -- a failed or canceled payment must never silently keep Pro
// active. This is intentionally a small allowlist rather than a denylist so
// that new/unexpected Stripe statuses default to "not entitled".
const ACTIVE_STATUSES = new Set(["trialing", "active"]);

/**
 * Derives the caller's plan from Stripe subscription data synced into the
 * `stripe.subscriptions` table by stripe-replit-sync (webhooks are the
 * source of truth -- we never trust anything the client claims). If a user
 * has multiple subscriptions (e.g. an old canceled one plus a new one), the
 * most recently created record is used.
 */
export async function getEntitlements(stripeCustomerId: string | null): Promise<Entitlements> {
  if (!stripeCustomerId) {
    return { plan: "free", status: null, currentPeriodEnd: null, trialEnd: null, cancelAtPeriodEnd: false };
  }

  const result = await db.execute(sql`
    SELECT status, current_period_end, trial_end, cancel_at_period_end
    FROM stripe.subscriptions
    WHERE customer = ${stripeCustomerId}
    ORDER BY created DESC
    LIMIT 1
  `);

  const row = result.rows[0] as
    | {
        status: string;
        current_period_end: number | string | null;
        trial_end: number | string | null;
        cancel_at_period_end: boolean | null;
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

  const plan: Plan = ACTIVE_STATUSES.has(row.status) ? "pro" : "free";

  return {
    plan,
    status: row.status,
    currentPeriodEnd: toDate(row.current_period_end),
    trialEnd: toDate(row.trial_end),
    cancelAtPeriodEnd: row.cancel_at_period_end ?? false,
  };
}

export async function requirePro(stripeCustomerId: string | null): Promise<boolean> {
  const entitlements = await getEntitlements(stripeCustomerId);
  return entitlements.plan === "pro";
}
