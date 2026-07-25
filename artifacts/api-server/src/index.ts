import { runMigrations } from "stripe-replit-sync";
import { sql } from "drizzle-orm";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import app from "./app";
import { logger } from "./lib/logger";
import { seedDatabase, applyVideoOffsetFixes } from "./lib/seed";
import { attachLiveSocketServer } from "./lib/liveSocket";
import { liveStreamRegistry } from "./lib/liveStream";
import { getStripeSync } from "./lib/stripeClient";
import { db } from "@workspace/db";
import { resumeHighlightJob } from "./routes/highlights";
import { resumeLowlightJob } from "./routes/lowlights";

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

  // runMigrations() silently skips when its migrations directory is missing
  // (e.g. a bundling mistake). Verify the schema actually exists so a broken
  // build fails loudly here instead of surfacing as a confusing downstream
  // error — subscriptions are entirely dead without these tables.
  const check = await db.execute(
    sql`SELECT to_regclass('stripe.accounts') AS tbl`,
  );
  if (!check.rows[0]?.tbl) {
    // This is a definitive check (the query succeeded; the table is missing),
    // not a transient DB error — so exit instead of throwing: initStripe's
    // caller swallows errors into a single log line, and serving traffic with
    // payments silently dead is exactly the failure mode that broke
    // production. A failed boot is loud; autoscale surfaces it.
    logger.error(
      "Stripe migrations did not run: stripe.accounts table is missing. " +
        "Check that dist/migrations was included in the build. Exiting.",
    );
    process.exit(1);
  }

  const stripeSync = await getStripeSync();

  const webhookBaseUrl = `https://${process.env.REPLIT_DOMAINS?.split(",")[0]}`;
  await stripeSync.findOrCreateManagedWebhook(`${webhookBaseUrl}/api/stripe/webhook`);

  // NOTE: syncBackfill() with no params hits the library's default switch
  // branch and syncs NOTHING — { object: "all" } is required for a real
  // backfill. Only run it when the tables are empty (first boot on a fresh
  // database): it syncs every historical Stripe object, so running it on
  // every ~8-min autoscale instance cycle would grow boot latency unboundedly
  // with the customer base. After the one-time backfill, webhooks keep the
  // tables in sync.
  const seeded = await db.execute(sql`SELECT 1 FROM stripe.products LIMIT 1`);
  if (seeded.rows.length === 0) {
    logger.info("Stripe tables empty — running one-time full backfill");
    await stripeSync.syncBackfill({ object: "all" });
  }
}

/**
 * Delete orphaned video temp dirs left behind when a previous server instance
 * was OOM-killed mid-download (SIGKILL skips finally-blocks, so cleanup code
 * never ran). Without this, each OOM cycle accumulates GB of abandoned files
 * and the disk fills up progressively faster with every restart.
 */
async function cleanupOrphanedTempDirs(): Promise<void> {
  const tmpDir = os.tmpdir();
  try {
    const entries = await fs.readdir(tmpDir);
    const orphaned = entries.filter(
      (e) => e.startsWith("hl-") || e.startsWith("ll-") || e.startsWith("video-src-"),
    );
    for (const dir of orphaned) {
      await fs.rm(path.join(tmpDir, dir), { recursive: true, force: true }).catch(() => {});
    }
    if (orphaned.length > 0) {
      logger.info({ count: orphaned.length }, "Cleaned up orphaned video temp dirs");
    }
  } catch (err) {
    logger.warn({ err }, "Could not clean up orphaned video temp dirs");
  }
}

/**
 * On startup, re-trigger any highlight/lowlight jobs that were left in
 * "processing" by a previous server instance (Replit cycles production
 * instances every ~8 min). The 60-minute cutoff matches STALE_PROCESSING_MS
 * so we never pick up jobs that are genuinely too old.
 */
async function resumeOrphanedJobs(): Promise<void> {
  try {
    // Use 150 min — matches STALE_PROCESSING_MS (140 min) with headroom so
    // jobs that have been dormant since before the last few restarts are
    // also picked back up (e.g. a job started hours ago that was silently
    // skipped because it predated the old 60-min window).
    const cutoff = new Date(Date.now() - 150 * 60 * 1000);
    const rows = await db.execute(sql`
      SELECT id, highlight_status, highlight_started_at, lowlight_status, lowlight_started_at
      FROM games
      WHERE
        (highlight_status = 'processing' AND highlight_started_at > ${cutoff})
        OR
        (lowlight_status  = 'processing' AND lowlight_started_at  > ${cutoff})
    `);
    for (const row of rows.rows) {
      const gameId = Number(row.id);
      if (row.highlight_status === "processing") {
        logger.info({ gameId }, "Resuming orphaned highlight job after restart");
        resumeHighlightJob(gameId);
      }
      if (row.lowlight_status === "processing") {
        logger.info({ gameId }, "Resuming orphaned lowlight job after restart");
        resumeLowlightJob(gameId);
      }
    }
  } catch (err) {
    logger.error({ err }, "Failed to resume orphaned reel jobs on startup");
  }
}

Promise.all([
  seedDatabase().catch((err) => {
    logger.error({ err }, "Error seeding database");
  }),
  applyVideoOffsetFixes().catch((err) => {
    logger.error({ err }, "Error applying video offset fixes");
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
  liveStreamRegistry.startCleanupTimer();

  // Clean up temp dirs orphaned by previous OOM kills, then resume jobs.
  setTimeout(() => {
    void cleanupOrphanedTempDirs().finally(() => resumeOrphanedJobs());
  }, 5_000);
});
