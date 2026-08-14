import { runMigrations } from "stripe-replit-sync";
import { sql } from "drizzle-orm";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import app from "./app";
import { logger } from "./lib/logger";
import { attachLiveSocketServer } from "./lib/liveSocket";
import { liveStreamRegistry, checkTurnAvailability } from "./lib/liveStream";
import { getStripeSync, getStripeCredentials, probeStripeKey } from "./lib/stripeClient";
import { db } from "@workspace/db";
import { resumeHighlightJob } from "./routes/highlights";
import { resumeLowlightJob } from "./routes/lowlights";
import { seedDatabase, applyVideoOffsetFixes, applySchemaAdditions } from "./lib/seed";
import { PROXY_VERSION, buildGameProxyNow } from "./lib/highlightGenerator";

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

// Preflight: REVENUECAT_WEBHOOK_SECRET must be set in production.
// Without it the webhook endpoint rejects every RevenueCat event (purchases,
// renewals, expirations), silently breaking all mobile entitlements.
// Fail at boot rather than silently serving broken traffic.
if (process.env["NODE_ENV"] === "production" && !process.env["REVENUECAT_WEBHOOK_SECRET"]) {
  // Use console.error here because the logger may not be initialised yet.
  console.error(
    "[FATAL] REVENUECAT_WEBHOOK_SECRET is not set in production. " +
      "All RevenueCat webhook events will be rejected. Set the secret and redeploy.",
  );
  process.exit(1);
}

// Preflight: SESSION_SECRET must be set in production.
// Without it, session cookies cannot be signed and every authenticated request
// will fail immediately. Fail at boot rather than silently serving broken traffic.
if (process.env["NODE_ENV"] === "production" && !process.env["SESSION_SECRET"]) {
  console.error(
    "[FATAL] SESSION_SECRET is not set in production. " +
      "Session cookies cannot be signed; every authenticated request will fail. " +
      "Set the secret and redeploy.",
  );
  process.exit(1);
}

// Preflight: CLERK_SECRET_KEY must be set in production.
// Without it, Clerk server-side auth is completely broken — middleware cannot
// verify JWTs so all protected routes become inaccessible to every user.
// Fail at boot rather than silently serving broken traffic.
if (process.env["NODE_ENV"] === "production" && !process.env["CLERK_SECRET_KEY"]) {
  console.error(
    "[FATAL] CLERK_SECRET_KEY is not set in production. " +
      "Clerk server-side authentication is completely broken without this key. " +
      "Set the secret and redeploy.",
  );
  process.exit(1);
}

// Preflight: fast synchronous check — if STRIPE_SECRET_KEY is absent and the
// connector env vars are also absent, we can fail immediately without an async
// fetch. The definitive check (getStripeCredentials()) runs async below and
// will also catch mis-configured connectors (env vars present but Stripe not
// actually connected).
if (process.env["NODE_ENV"] === "production") {
  const hasDirectKey = Boolean(process.env["STRIPE_SECRET_KEY"]);
  const hasConnector =
    Boolean(process.env["REPLIT_CONNECTORS_HOSTNAME"]) &&
    (Boolean(process.env["REPL_IDENTITY"]) || Boolean(process.env["WEB_REPL_RENEWAL"]));

  if (!hasDirectKey && !hasConnector) {
    console.error(
      "[FATAL] No Stripe credentials are configured in production. " +
        "Set STRIPE_SECRET_KEY in Secrets, or connect Stripe via the Integrations tab. " +
        "Without this, all billing operations will fail at runtime.",
    );
    process.exit(1);
  }
}

// Note: CLERK_PROXY_URL may be injected automatically by the Replit Clerk
// integration at production runtime. IMPORTANT: this value must NOT be
// forwarded as a proxyUrl option to clerkMiddleware() in app.ts. Doing so
// would cause clerkMiddleware to expect iss: <proxyUrl> and reject every
// live mobile Bearer token (whose iss is the Clerk FAPI domain). The
// clerkMiddleware() call in app.ts intentionally omits proxyUrl so that
// mobile tokens are verified directly by Clerk's standard JWKS path.
if (process.env["NODE_ENV"] === "production" && process.env["CLERK_PROXY_URL"]) {
  console.info(
    "[INFO] CLERK_PROXY_URL is set in production (injected by Replit). " +
      "It is NOT forwarded to clerkMiddleware() — mobile Bearer tokens are " +
      "verified directly via Clerk's standard JWKS path without a proxy iss override.",
  );
}

// Preflight: STRIPE_WEBHOOK_SECRET must be set in production when using the
// direct STRIPE_SECRET_KEY path (the preferred and documented production setup).
// Without it, StripeSync falls back to an empty string for signature
// verification and rejects every Stripe event — subscription purchases,
// renewals, and cancellations all fail silently, breaking billing for every user.
// Fail at boot rather than silently serving broken traffic.
if (
  process.env["NODE_ENV"] === "production" &&
  process.env["STRIPE_SECRET_KEY"] &&
  !process.env["STRIPE_WEBHOOK_SECRET"]
) {
  console.error(
    "[FATAL] STRIPE_WEBHOOK_SECRET is not set in production. " +
      "All Stripe webhook events (purchases, renewals, cancellations) will be " +
      "rejected, breaking billing for every user. Set the secret and redeploy.",
  );
  process.exit(1);
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

  // One-time cleanup: delete two specific managed-webhook rows that were created
  // by findOrCreateManagedWebhook during development (before STRIPE_WEBHOOK_BASE_URL
  // was guarded). Both pointed at stecstats.replit.app; their underlying Stripe
  // endpoints are already gone (Stripe returns 404), so the rows are dead orphans.
  // Targeting exact IDs makes this truly one-time: once deleted the WHERE never
  // matches again, so there is no ongoing runtime cost or risk on future boots.
  // IDs of the two known stale rows (both pointed at stecstats.replit.app before
  // STRIPE_WEBHOOK_BASE_URL was guarded). Hardcoded so the WHERE is exact and
  // the DELETE becomes a no-op after the first successful boot.
  const staleWebhookResult = await db.execute(
    sql`DELETE FROM stripe._managed_webhooks
        WHERE id = ${"we_1TxVHYGL3YM0YNIJQpsGznTE"}
           OR id = ${"we_1TxY53PvBw5ornXn9AY9CvUc"}
        RETURNING id, url`,
  );
  if (staleWebhookResult.rows.length > 0) {
    logger.info(
      { deleted: staleWebhookResult.rows.map((r) => ({ id: r.id, url: r.url })) },
      `Removed ${staleWebhookResult.rows.length} stale managed webhook row(s) pointing at dev URLs`,
    );
  }

  const stripeSync = await getStripeSync();

  // Only register the managed webhook when STRIPE_WEBHOOK_BASE_URL is
  // explicitly set (production only). In dev, REPLIT_DOMAINS resolves to the
  // temporary .riker.replit.dev workspace URL; calling findOrCreateManagedWebhook
  // there creates a live-mode Stripe webhook endpoint at the dev URL, overwrites
  // the DB secret, and breaks production signature verification for every real
  // Stripe event. The fix: require an explicit STRIPE_WEBHOOK_BASE_URL (set to
  // https://stecstats.com in production Secrets) and skip the call when it's absent.
  const webhookBaseUrl = process.env.STRIPE_WEBHOOK_BASE_URL;
  if (webhookBaseUrl) {
    logger.info(
      { webhookBaseUrl },
      "Registering managed Stripe webhook endpoint",
    );
    await stripeSync.findOrCreateManagedWebhook(`${webhookBaseUrl}/api/stripe/webhook`);
  } else {
    logger.info(
      "STRIPE_WEBHOOK_BASE_URL is not set — skipping managed webhook registration. " +
        "Set STRIPE_WEBHOOK_BASE_URL=https://stecstats.com in production Secrets to enable it.",
    );
  }

  // NOTE: syncBackfill() with no params hits the library's default switch
  // branch and syncs NOTHING — { object: "all" } is required for a real
  // backfill. Only run it when the tables are empty (first boot on a fresh
  // database): it syncs every historical Stripe object, so running it on
  // every ~8-min autoscale instance cycle would grow boot latency unboundedly
  // with the customer base. After the one-time backfill, webhooks keep the
  // tables in sync.
  //
  // Three-tier guard:
  //  1. No products → genuinely fresh DB, run a full backfill.
  //  2. Products exist but no subscriptions → the webhook was briefly down
  //     during initial customer sign-ups so subscriptions (and their parent
  //     customers) never landed in the DB.  Re-sync customers + subscriptions
  //     only; products/prices are already present so this is fast.
  //  3. Both exist — consult stripe._sync_status to determine whether the
  //     sync pipeline has been silent for longer than the recovery threshold.
  //     _sync_status.updated_at is stamped by markSyncRunning/markSyncComplete
  //     at the start and end of every syncSubscriptions() call, even when 0
  //     items are returned.  This makes it a true "last sync heartbeat" — it
  //     reflects sync activity, not subscription-creation recency — so a
  //     healthy team with no new sign-ups for >24 h will NOT trigger recovery
  //     as long as the webhook kept firing on renewals/updates/cancellations
  //     that caused at least one explicit sync run within the threshold window.
  //     When the gap IS stale (webhook truly down), run a targeted sync using
  //     last_incremental_cursor as the lower bound so we only ask Stripe for
  //     the missing window.
  //  4. Both exist and sync is current → skip entirely (performance guard, the
  //     common case — zero Stripe API calls on normal boots).
  const seeded = await db.execute(sql`SELECT 1 FROM stripe.products LIMIT 1`);
  if (seeded.rows.length === 0) {
    logger.info("Stripe tables empty — running one-time full backfill");
    await stripeSync.syncBackfill({ object: "all" });
  } else {
    const subSeeded = await db.execute(
      sql`SELECT 1 FROM stripe.subscriptions LIMIT 1`,
    );
    if (subSeeded.rows.length === 0) {
      logger.info(
        "Stripe products present but subscriptions table is empty — " +
          "webhook may have been down during initial sign-ups; " +
          "backfilling customers and subscriptions",
      );
      // Sync customers first so FK references from subscriptions resolve.
      await stripeSync.syncCustomers();
      await stripeSync.syncSubscriptions();
    } else {
      // Tier 3: subscriptions exist — check stripe._sync_status for sync lag.
      //
      // STRIPE_SUBSCRIPTION_RECOVERY_HOURS controls the threshold (default
      // 24 h). Set to 0 to disable the gap check entirely.
      const recoveryHours = Math.max(
        0,
        Number(process.env["STRIPE_SUBSCRIPTION_RECOVERY_HOURS"] ?? "24"),
      );

      if (recoveryHours > 0) {
        // _sync_status.updated_at is set by markSyncRunning/markSyncComplete
        // on every syncSubscriptions() invocation, even when Stripe returns
        // 0 results. This is a true sync-health heartbeat (not signup
        // recency), so it does NOT produce false positives on teams that
        // simply haven't had new subscribers lately.
        //
        // last_incremental_cursor is the max `created` epoch of all
        // subscriptions seen via explicit syncs; used as the lower bound for
        // the targeted recovery window so we only fetch missed subscriptions.
        //
        // NOTE: EXTRACT(EPOCH FROM …) returns PostgreSQL float8 (double
        // precision). node-postgres maps float8 → JS number, so no cast is
        // needed. We still run every value through Number() + Number.isFinite()
        // to guard against unexpected driver or ORM coercions (e.g. bigint
        // columns returned as strings in some environments).
        const syncStatusResult = await db.execute(
          sql`
            SELECT
              EXTRACT(EPOCH FROM updated_at)          AS last_sync_epoch,
              EXTRACT(EPOCH FROM last_incremental_cursor) AS cursor_epoch
            FROM stripe._sync_status
            WHERE resource = 'subscriptions'
            LIMIT 1
          `,
        );

        const statusRow = syncStatusResult.rows[0];

        // Coerce to number and guard against NULL / non-finite values.
        const lastSyncEpoch = statusRow
          ? Number(statusRow.last_sync_epoch)
          : NaN;

        if (!statusRow || !Number.isFinite(lastSyncEpoch)) {
          // No _sync_status row for subscriptions — sync has never completed
          // via the cursor mechanism (e.g. library state was reset). Skip
          // recovery conservatively; the tier-2 guard already handles the
          // empty-table case.
          logger.info(
            "No stripe._sync_status row for subscriptions — cannot determine sync lag; skipping gap recovery",
          );
        } else {
          const thresholdEpoch =
            Math.floor(Date.now() / 1000) - recoveryHours * 3600;

          if (lastSyncEpoch >= thresholdEpoch) {
            logger.info(
              { lastSyncEpoch, recoveryHours },
              "Stripe subscription sync is current — skipping gap recovery",
            );
          } else {
            // Sync pipeline has been silent for longer than the threshold.
            // Determine the lower bound for the recovery window.
            let syncFromEpoch: number;
            // Explicit null/undefined guard before Number() coercion:
            // Number(null) === 0, which is finite and would silently skip the
            // MAX(created) fallback. Treat null/undefined cursor as "no cursor".
            const rawCursor = statusRow.cursor_epoch;
            const cursorEpoch =
              rawCursor == null ? NaN : Number(rawCursor);
            if (Number.isFinite(cursorEpoch)) {
              // Use the cursor: the last subscription `created` timestamp we
              // successfully ingested, so we only fetch what came after.
              syncFromEpoch = cursorEpoch;
            } else {
              // Cursor is NULL (all subscriptions arrived via webhook, never
              // via an explicit sync). Fall back to MAX(created) from the
              // table so we don't re-fetch the entire history.
              const maxCreatedResult = await db.execute(
                sql`SELECT MAX(created) AS max_created FROM stripe.subscriptions`,
              );
              const maxCreated = Number(
                maxCreatedResult.rows[0]?.max_created,
              );
              syncFromEpoch = Number.isFinite(maxCreated)
                ? maxCreated
                : thresholdEpoch;
            }

            const gapHours = (
              (Date.now() / 1000 - lastSyncEpoch) /
              3600
            ).toFixed(1);
            logger.warn(
              {
                lastSyncEpoch,
                syncFromEpoch,
                gapHours,
                recoveryHours,
              },
              "Stripe subscription sync gap detected — last sync was " +
                `${gapHours}h ago (threshold: ${recoveryHours}h). ` +
                "Webhook may have been down; syncing gap period only.",
            );

            // Sync customers first so FK references from subscriptions resolve.
            await stripeSync.syncCustomers({ created: { gt: syncFromEpoch } });
            await stripeSync.syncSubscriptions({
              created: { gt: syncFromEpoch },
            });
            logger.info("Stripe gap recovery sync complete");
          }
        }
      }
    }
  }
}

/**
 * Delete orphaned video temp dirs left behind when a previous server instance
 * was OOM-killed mid-build (SIGKILL skips finally-blocks so cleanup never
 * ran). Without this each OOM cycle accumulates GB of abandoned files and
 * disk fills progressively faster with every restart.
 *
 * Prefixes cleaned:
 *   video-proxy-*  — chunked proxy builds (~1.4 GB each, most dangerous)
 *   hl-*           — per-clip highlight extraction dirs
 *   ll-*           — per-clip lowlight extraction dirs
 */
async function cleanupOrphanedTempDirs(): Promise<void> {
  const tmpDir = os.tmpdir();
  try {
    const entries = await fs.readdir(tmpDir);
    const orphaned = entries.filter(
      (e) =>
        e.startsWith("video-proxy-") ||
        e.startsWith("hl-") ||
        e.startsWith("ll-"),
    );
    await Promise.all(
      orphaned.map((dir) =>
        fs.rm(path.join(tmpDir, dir), { recursive: true, force: true }).catch(() => {}),
      ),
    );
    if (orphaned.length > 0) {
      logger.info({ count: orphaned.length }, "Cleaned up orphaned video temp dirs");
    }
  } catch (err) {
    logger.warn({ err }, "Could not clean up orphaned video temp dirs");
  }
}

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

/**
 * One-time boot-time sweep: find every game that has a recorded video but
 * lacks a current-version proxy, and build those proxies in the background.
 *
 * Rate-limited to CONCURRENCY=2 simultaneous builds so we don't OOM the
 * server by downloading multiple large videos at once.  The sweep is fully
 * idempotent — re-running it (e.g. after a server restart) just no-ops
 * games whose proxies are already valid.
 */
async function sweepMissingProxies(): Promise<void> {
  const CONCURRENCY = 2;
  try {
    const rows = await db.execute(sql`
      SELECT id, owner_id
      FROM games
      WHERE video_object_path IS NOT NULL
        AND video_duration_ms > 0
        AND video_duration_ms <= ${900 * 1000}
        AND (
          video_proxy_object_path IS NULL
          OR video_proxy_version IS NULL
          OR video_proxy_version != ${PROXY_VERSION}
        )
      ORDER BY id DESC
    `);

    const games = rows.rows as { id: unknown; owner_id: unknown }[];
    if (games.length === 0) {
      logger.info("Proxy sweep: all games already have a current-version proxy — nothing to do");
      return;
    }

    logger.info(
      { count: games.length, proxyVersion: PROXY_VERSION },
      "Proxy sweep: starting — games with missing or stale proxies",
    );

    // Process in batches of CONCURRENCY so at most 2 builds run at once.
    for (let i = 0; i < games.length; i += CONCURRENCY) {
      const batch = games.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map((row) =>
          buildGameProxyNow(Number(row.id), Number(row.owner_id)),
        ),
      );
      logger.info(
        { processed: Math.min(i + CONCURRENCY, games.length), total: games.length },
        "Proxy sweep: batch complete",
      );
    }

    logger.info({ total: games.length }, "Proxy sweep: finished");
  } catch (err) {
    logger.error({ err }, "Proxy sweep: failed to query or process games");
  }
}

async function boot() {
  // Definitive Stripe credential check: actually resolve credentials before
  // accepting any traffic. This catches cases where connector env vars are
  // present but Stripe is not connected (or the connector fetch fails), which
  // the synchronous env-var heuristic above cannot detect.
  if (process.env["NODE_ENV"] === "production") {
    let resolvedKey: string;
    try {
      const creds = await getStripeCredentials();
      resolvedKey = creds.secretKey;
      const sourceLabel =
        creds.source === "direct-secret"
          ? "direct secret key (STRIPE_SECRET_KEY)"
          : "Replit connector";
      logger.info(`Stripe credentials loaded from ${sourceLabel}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        "[FATAL] Could not resolve Stripe credentials at startup. " +
          "All billing operations will fail. " +
          "Set STRIPE_SECRET_KEY in Secrets or connect Stripe via the Integrations tab. " +
          `Error: ${message}`,
      );
      process.exit(1);
    }

    // Probe the key — a key that exists can still be revoked, expired, or
    // mistyped. stripe.balance.retrieve() is the cheapest authenticated call.
    const probe = await probeStripeKey(resolvedKey);
    if (!probe.ok) {
      if (probe.authError) {
        console.error(
          "[FATAL] Stripe key is invalid (authentication error). " +
            "The key may be revoked, expired, or mistyped. " +
            "Update STRIPE_SECRET_KEY in Secrets and redeploy. " +
            `Error: ${probe.message}`,
        );
        process.exit(1);
      } else {
        // Transient error (network timeout, Stripe outage) — warn but continue.
        logger.warn(
          { message: probe.message },
          "Stripe key probe failed with a non-auth error. " +
            "Continuing boot — Stripe's API may be briefly unreachable.",
        );
      }
    } else {
      logger.info("Stripe key probe succeeded — credentials are valid");

      // After a successful probe, check whether the key is a test key.
      // A sk_test_ key will pass authentication but will never settle real
      // money — deploying with one is a silent billing failure.
      if (resolvedKey.startsWith("sk_test_")) {
        console.error(
          "[FATAL] Stripe test key (sk_test_) detected in production. " +
            "Test keys do not process real payments. " +
            "Replace STRIPE_SECRET_KEY with a live key (sk_live_) and redeploy.",
        );
        process.exit(1);
      }
    }
  }

  // In development, warn if a test key is in use so it's visible in logs
  // (normal and expected in dev, but worth surfacing so developers notice
  // if they accidentally swap environments).
  if (process.env["NODE_ENV"] !== "production") {
    const devKey =
      process.env["STRIPE_SECRET_KEY"] ?? "";
    if (devKey.startsWith("sk_test_")) {
      const stripeTestKeyMsg =
        "Stripe test key (sk_test_) detected — this is expected in development " +
        "but ensure a live key (sk_live_) is used before going to production.";
      logger.warn(stripeTestKeyMsg);
      console.warn("[WARN] " + stripeTestKeyMsg);
    }
  }

  // Log which RevenueCat credential path is active so operators can confirm
  // the correct path without exposing the secret value itself.
  {
    const rcSource = process.env["REVENUECAT_WEBHOOK_SECRET"]
      ? "direct env var (REVENUECAT_WEBHOOK_SECRET)"
      : "not configured";
    logger.info(`RevenueCat webhook credentials: ${rcSource}`);
  }

  await applySchemaAdditions().catch((err) => {
    logger.error({ err }, "Error applying schema additions — column may be missing");
  });

  await Promise.all([
    seedDatabase().catch((err) => {
      logger.error({ err }, "Error seeding database");
    }),
    applyVideoOffsetFixes().catch((err) => {
      logger.error({ err }, "Error applying video offset fixes");
    }),
    // In production, Stripe init failure is fatal — serving traffic with
    // billing silently dead is worse than a failed boot. Outside production,
    // log and continue so local development without Stripe keys still works.
    initStripe().catch((err) => {
      if (process.env["NODE_ENV"] === "production") {
        console.error(
          "[FATAL] Stripe initialization failed in production. " +
            "Billing is non-functional. Exiting. Error: " +
            (err instanceof Error ? err.message : String(err)),
        );
        process.exit(1);
      }
      logger.error({ err }, "Error initializing Stripe");
    }),
  ]);

  const server = app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }

    logger.info({ port }, "Server listening");
  });

  attachLiveSocketServer(server);
  liveStreamRegistry.startCleanupTimer();

  // Check TURN relay availability once at startup and log the result so
  // operators know immediately if streams will fall back to STUN-only on
  // restrictive gym/school networks.
  void checkTurnAvailability();

  // Clean up temp dirs orphaned by previous OOM kills, then resume jobs.
  // After that, kick off the proxy sweep with a further delay so it doesn't
  // compete with the initial reel-resume I/O spike.
  setTimeout(() => {
    void cleanupOrphanedTempDirs()
      .finally(() => resumeOrphanedJobs())
      .finally(() => {
        setTimeout(() => void sweepMissingProxies(), 30_000);
      });
  }, 5_000);
}

boot().catch((err) => {
  console.error("[FATAL] Unexpected error during server boot:", err);
  process.exit(1);
});
