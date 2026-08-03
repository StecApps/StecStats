import type { Request, Response } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { logger } from "../lib/logger";

/**
 * POST /api/revenuecat/webhook
 *
 * Receives RevenueCat server-to-server event notifications and updates the
 * local `users.revenue_cat_entitlement` column so that `/api/billing/status`
 * reflects the subscriber's mobile plan without requiring a Stripe subscription.
 *
 * RevenueCat sends the Clerk user ID as `app_user_id` because the mobile app
 * calls `Purchases.logIn(clerkUserId)` after sign-in.
 *
 * Webhook authorization: if REVENUECAT_WEBHOOK_SECRET is set, only requests
 * whose `Authorization` header matches `Bearer <secret>` are accepted.
 * Leave the env var unset to skip auth (useful in development / before the
 * RC dashboard webhook secret is configured).
 *
 * This is exported as a plain RequestHandler (not a Router) so it can be
 * mounted with raw body parsing in app.ts before express.json().
 */
export async function handleRevenueCatWebhook(req: Request, res: Response): Promise<void> {
  // Shared-secret auth (set in RevenueCat dashboard → Webhooks → Authorization header).
  // In production the secret is mandatory — missing it is a misconfiguration that
  // would leave the endpoint open to spoofed entitlement grants.
  const secret = process.env["REVENUECAT_WEBHOOK_SECRET"];
  const isProd = process.env["NODE_ENV"] === "production";

  if (!secret) {
    if (isProd) {
      // Hard-fail in production — accepting unauthenticated writes on a paid-feature
      // endpoint is a security vulnerability.
      logger.error("RevenueCat webhook: REVENUECAT_WEBHOOK_SECRET is not set in production. Rejecting request.");
      res.status(500).json({ error: "Webhook secret not configured" });
      return;
    }
    // In development log a warning but allow the request through so the endpoint
    // can be exercised without setting up the RC dashboard first.
    logger.warn("RevenueCat webhook: REVENUECAT_WEBHOOK_SECRET not set — accepting unauthenticated request (development only)");
  } else {
    const authHeader = req.headers["authorization"] ?? "";
    const expected = `Bearer ${secret}`;
    if (authHeader !== expected) {
      logger.warn("RevenueCat webhook: invalid authorization header");
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
  }

  // Body is a raw Buffer when mounted before express.json(); parse it here.
  let body: Record<string, unknown>;
  try {
    const raw = req.body instanceof Buffer ? req.body.toString("utf8") : JSON.stringify(req.body);
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    res.status(400).json({ error: "Invalid JSON body" });
    return;
  }

  const event = body["event"] as Record<string, unknown> | undefined;
  if (!event) {
    res.status(400).json({ error: "Missing event object" });
    return;
  }

  const eventType = event["type"] as string | undefined;
  const appUserId = event["app_user_id"] as string | undefined; // Clerk user ID

  if (!eventType || !appUserId) {
    res.status(400).json({ error: "Missing event.type or event.app_user_id" });
    return;
  }

  logger.info({ eventType, appUserId }, "RevenueCat webhook received");

  // Events that grant or renew an entitlement
  const GRANT_EVENTS = new Set([
    "INITIAL_PURCHASE",
    "RENEWAL",
    "PRODUCT_CHANGE",
    "UNCANCELLATION",
    "TRANSFER",
    "SUBSCRIPTION_PAUSED",  // paused still has access until period_end
    "TEMPORARY_ENTITLEMENT_GRANT",
  ]);

  try {
    if (GRANT_EVENTS.has(eventType)) {
      // Determine tier from entitlement IDs
      const entitlementIds = (event["entitlement_ids"] as string[] | undefined) ?? [];
      const entitlementId = event["entitlement_id"] as string | undefined;
      const allIds = entitlementId ? [entitlementId, ...entitlementIds] : entitlementIds;

      let entitlement: "premium" | "pro" | null = null;
      for (const id of allIds) {
        const lower = id.toLowerCase();
        if (lower === "premium") {
          entitlement = "premium";
          break;
        } else if (lower === "pro") {
          entitlement = "pro";
        }
      }

      if (!entitlement) {
        // Unknown entitlement ID — no-op rather than defaulting to pro, which
        // would grant access to users who shouldn't have it if RC entitlement
        // naming drifts (e.g. "Pro" renamed in the RC dashboard).
        logger.warn({ appUserId, allIds, eventType }, "RevenueCat: unrecognized entitlement IDs, skipping grant");
        res.status(200).json({ received: true });
        return;
      }

      await db
        .update(usersTable)
        .set({ revenueCatEntitlement: entitlement })
        .where(eq(usersTable.clerkUserId, appUserId));

      logger.info({ appUserId, entitlement, eventType }, "RevenueCat: entitlement granted");

    } else if (eventType === "EXPIRATION" || eventType === "BILLING_ISSUE") {
      // EXPIRATION fires when access truly ends; BILLING_ISSUE means payment failed.
      // CANCELLATION is intentionally NOT cleared here — the user still has access
      // until the period end; EXPIRATION will clear it when access ends.
      await db
        .update(usersTable)
        .set({ revenueCatEntitlement: null })
        .where(eq(usersTable.clerkUserId, appUserId));
      logger.info({ appUserId, eventType }, "RevenueCat: entitlement revoked");

    } else if (eventType === "CANCELLATION") {
      // Don't clear yet — user retains access until period end.
      // The EXPIRATION event will clear it when access truly ends.
      logger.info({ appUserId, eventType }, "RevenueCat: subscription cancelled (access retained until period end)");

    } else {
      logger.info({ eventType, appUserId }, "RevenueCat: unhandled event type (no-op)");
    }

    res.status(200).json({ received: true });
  } catch (err) {
    logger.error({ err, eventType, appUserId }, "RevenueCat webhook processing error");
    res.status(500).json({ error: "Internal server error" });
  }
}
