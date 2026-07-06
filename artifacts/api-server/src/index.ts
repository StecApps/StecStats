import { runMigrations } from "stripe-replit-sync";
import app from "./app";
import { logger } from "./lib/logger";
import { seedDatabase } from "./lib/seed";
import { attachLiveSocketServer } from "./lib/liveSocket";
import { getStripeSync } from "./lib/stripeClient";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

/**
 * Sets up the `stripe` schema, registers the managed webhook, and backfills
 * existing Stripe data. Order matters: migrations must run before the
 * StripeSync instance is used for anything else.
 */
async function initStripe() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is required for Stripe integration.");
  }

  await runMigrations({ databaseUrl });

  const stripeSync = await getStripeSync();

  const webhookBaseUrl = `https://${process.env.REPLIT_DOMAINS?.split(",")[0]}`;
  await stripeSync.findOrCreateManagedWebhook(`${webhookBaseUrl}/api/stripe/webhook`);

  await stripeSync.syncBackfill();
}

Promise.all([
  seedDatabase().catch((err) => {
    logger.error({ err }, "Error seeding database");
  }),
  initStripe().catch((err) => {
    logger.error({ err }, "Error initializing Stripe");
  }),
]).finally(() => {
  const server = app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }

    logger.info({ port }, "Server listening");
  });

  attachLiveSocketServer(server);
});
