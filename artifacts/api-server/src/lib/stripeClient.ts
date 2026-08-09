import Stripe from "stripe";
import { StripeSync } from "stripe-replit-sync";

/**
 * Fetches Stripe credentials from the Replit connection API.
 * Not cached -- tokens can rotate, so fetch fresh each time.
 *
 * Exported so boot-time preflight guards can call it directly.
 */
export async function getStripeCredentials(): Promise<{ secretKey: string; webhookSecret?: string; source: "direct-secret" | "replit-connector" }> {
  // Prefer a directly-set secret — this reliably works in both dev and
  // the deployed production environment. The Replit connector approach
  // below is kept as a fallback for local development convenience.
  if (process.env.STRIPE_SECRET_KEY) {
    return {
      secretKey: process.env.STRIPE_SECRET_KEY,
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
      source: "direct-secret",
    };
  }

  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? "repl " + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
      ? "depl " + process.env.WEB_REPL_RENEWAL
      : null;

  if (!hostname || !xReplitToken) {
    throw new Error(
      "Stripe secret key not configured. Set STRIPE_SECRET_KEY in Secrets " +
        "or connect Stripe via the Integrations tab.",
    );
  }

  const resp = await fetch(
    `https://${hostname}/api/v2/connection?include_secrets=true&connector_names=stripe`,
    {
      headers: { Accept: "application/json", X_REPLIT_TOKEN: xReplitToken },
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (!resp.ok) {
    throw new Error(`Failed to fetch Stripe credentials: ${resp.status} ${resp.statusText}`);
  }

  const data = (await resp.json()) as {
    items?: Array<{ settings?: { secret?: string; webhook_secret?: string } }>;
  };
  const settings = data.items?.[0]?.settings;

  if (!settings?.secret) {
    throw new Error(
      "Stripe integration not connected or missing secret key. " +
        "Connect Stripe via the Integrations tab first.",
    );
  }

  return {
    secretKey: settings.secret,
    webhookSecret: settings.webhook_secret,
    source: "replit-connector",
  };
}

/**
 * Probes whether the given secret key is accepted by Stripe.
 *
 * Uses `stripe.balance.retrieve()` — the cheapest authenticated Stripe call.
 * Returns `{ ok: true }` on success.
 * Returns `{ ok: false, authError: true }` when Stripe rejects the key with a
 * 401/authentication_error (revoked, mistyped, or wrong-mode key).
 * Returns `{ ok: false, authError: false }` for transient errors (network
 * timeouts, Stripe outages) that should not abort boot.
 */
export async function probeStripeKey(secretKey: string): Promise<{
  ok: boolean;
  authError: boolean;
  message?: string;
}> {
  try {
    const stripe = new Stripe(secretKey);
    await stripe.balance.retrieve();
    return { ok: true, authError: false };
  } catch (err: unknown) {
    const isAuthError =
      err instanceof Stripe.errors.StripeAuthenticationError;
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, authError: isAuthError, message };
  }
}
/**
 * Returns a fresh authenticated Stripe client.
 * Not cached -- fetches credentials on every call so rotated keys are picked up.
 */
export async function getUncachableStripeClient(): Promise<Stripe> {
  const { secretKey } = await getStripeCredentials();
  return new Stripe(secretKey);
}

/**
 * Returns a fresh StripeSync instance for webhook processing and data sync.
 * Not cached -- fetches credentials on every call so rotated keys are picked up.
 */
export async function getStripeSync(): Promise<StripeSync> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is required");
  }

  const { secretKey, webhookSecret } = await getStripeCredentials();
  // STRIPE_WEBHOOK_SECRET env var takes precedence over the connector-supplied
  // webhook_secret. The connector's managed webhook is registered at the dev
  // workspace URL (REPLIT_DOMAINS), not the production custom domain, so its
  // secret won't match live events arriving at stecstats.com. Setting
  // STRIPE_WEBHOOK_SECRET explicitly pins the production webhook secret and
  // bypasses the wrong DB entry.
  const effectiveWebhookSecret =
    process.env.STRIPE_WEBHOOK_SECRET || webhookSecret || "";
  return new StripeSync({
    poolConfig: { connectionString: databaseUrl },
    stripeSecretKey: secretKey,
    stripeWebhookSecret: effectiveWebhookSecret,
  });
}
