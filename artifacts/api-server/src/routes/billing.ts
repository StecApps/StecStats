import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import {
  CreateCheckoutSessionBody,
  GetBillingStatusResponse,
  CreateCheckoutSessionResponse,
  CreateBillingPortalSessionResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { getUncachableStripeClient } from "../lib/stripeClient";
import { getEntitlements } from "../lib/entitlements";

const router: IRouter = Router();

function getAppBaseUrl(req: { protocol: string; get: (name: string) => string | undefined }): string {
  const domain = process.env.REPLIT_DOMAINS?.split(",")[0];
  if (domain) return `https://${domain}`;
  return `${req.protocol}://${req.get("host")}`;
}

router.get("/billing/status", requireAuth, async (req, res) => {
  const entitlements = await getEntitlements(req.appUser!.stripeCustomerId, req.appUser!.email);
  res.json(
    GetBillingStatusResponse.parse({
      plan: entitlements.plan,
      status: entitlements.status,
      currentPeriodEnd: entitlements.currentPeriodEnd,
      trialEnd: entitlements.trialEnd,
      cancelAtPeriodEnd: entitlements.cancelAtPeriodEnd,
      hasSoccer: entitlements.hasSoccer,
    }),
  );
});

router.post("/billing/checkout", requireAuth, async (req, res) => {
  const { interval, tier = "pro" } = CreateCheckoutSessionBody.parse(req.body);
  const appUser = req.appUser!;

  const stripe = await getUncachableStripeClient();

  // Look up the product/price fresh from Stripe rather than hardcoding price
  // ids, so re-seeding (e.g. in a new environment) doesn't require a code
  // change. Product names: "STEC STATS Pro", "STEC STATS Premium", "STEC STATS Soccer".
  const productName =
    tier === "premium" ? "STEC STATS Premium" :
    tier === "soccer"  ? "STEC STATS Soccer"  :
    "STEC STATS Pro";
  const products = await stripe.products.search({ query: `name:'${productName}' AND active:'true'` });
  const product = products.data[0];
  if (!product) {
    res.status(400).json({ error: `${tier === "premium" ? "Premium" : "Pro"} plan is not configured yet. Please try again later.` });
    return;
  }

  const prices = await stripe.prices.list({ product: product.id, active: true, limit: 10 });
  const price = prices.data.find((p) => p.recurring?.interval === interval);
  if (!price) {
    res.status(400).json({ error: `No active ${interval}ly price found for the ${tier === "premium" ? "Premium" : "Pro"} plan.` });
    return;
  }

  let customerId = appUser.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: appUser.email ?? undefined,
      metadata: { appUserId: String(appUser.id) },
    });
    customerId = customer.id;
    await db.update(usersTable).set({ stripeCustomerId: customerId }).where(eq(usersTable.id, appUser.id));
  }

  const baseUrl = getAppBaseUrl(req);
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [{ price: price.id, quantity: 1 }],
    subscription_data: { trial_period_days: 14 },
    success_url: `${baseUrl}/billing?checkout=success`,
    cancel_url: `${baseUrl}/billing?checkout=cancel`,
  });

  if (!session.url) {
    res.status(500).json({ error: "Failed to create checkout session" });
    return;
  }

  res.json(CreateCheckoutSessionResponse.parse({ url: session.url }));
});

router.post("/billing/portal", requireAuth, async (req, res) => {
  const appUser = req.appUser!;
  if (!appUser.stripeCustomerId) {
    res.status(404).json({ error: "No billing account found for this user yet." });
    return;
  }

  const stripe = await getUncachableStripeClient();
  const baseUrl = getAppBaseUrl(req);
  const session = await stripe.billingPortal.sessions.create({
    customer: appUser.stripeCustomerId,
    return_url: `${baseUrl}/billing`,
  });

  res.json(CreateBillingPortalSessionResponse.parse({ url: session.url }));
});

export default router;
