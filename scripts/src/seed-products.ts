import { getUncachableStripeClient } from "./stripeClient";

/**
 * Creates the Pro Plan product with monthly + annual prices in Stripe.
 * Idempotent -- checks for an existing active "STEC STATS Pro" product
 * before creating anything. The Free tier has no Stripe product; it is
 * simply the absence of an active/trialing subscription.
 *
 * Run with: pnpm --filter @workspace/scripts exec tsx src/seed-products.ts
 */
async function createProducts() {
  const stripe = await getUncachableStripeClient();

  console.log("Creating STEC STATS Pro product and prices in Stripe...");

  const existing = await stripe.products.search({
    query: "name:'STEC STATS Pro' AND active:'true'",
  });

  if (existing.data.length > 0) {
    console.log(`STEC STATS Pro already exists: ${existing.data[0].id}`);
    return;
  }

  const proProduct = await stripe.products.create({
    name: "STEC STATS Pro",
    description:
      "Unlimited players & seasons, career dashboard, shooting-efficiency gauges, live streaming, saved game video, and shareable player profiles.",
  });
  console.log(`Created product: ${proProduct.name} (${proProduct.id})`);

  const monthlyPrice = await stripe.prices.create({
    product: proProduct.id,
    unit_amount: 699,
    currency: "usd",
    recurring: { interval: "month" },
    nickname: "Pro Monthly",
  });
  console.log(`Created monthly price: $6.99/month (${monthlyPrice.id})`);

  const yearlyPrice = await stripe.prices.create({
    product: proProduct.id,
    unit_amount: 5900,
    currency: "usd",
    recurring: { interval: "year" },
    nickname: "Pro Annual",
  });
  console.log(`Created yearly price: $59.00/year (${yearlyPrice.id})`);

  console.log("Done. Webhooks will sync this data to the database automatically.");
}

createProducts().catch((error) => {
  console.error("Error creating products:", error instanceof Error ? error.message : error);
  process.exit(1);
});
