/**
 * Boot-time tests for the Stripe subscription gap-recovery guard (tier 3 of
 * initStripe).
 *
 * The guard consults stripe._sync_status.updated_at — a true sync-heartbeat
 * stamped by markSyncRunning/markSyncComplete on every syncSubscriptions()
 * call — to detect webhook outage windows that occurred *after* the initial
 * backfill. Unlike comparing MAX(stripe.subscriptions.created) against now(),
 * this approach does not produce false positives on teams that simply haven't
 * had new sign-ups lately.
 *
 * Scenarios covered:
 *   A. updated_at is recent (within threshold) → no Stripe API calls
 *   B. updated_at is stale (beyond threshold)  → targeted sync fires with
 *      { created: { gt: cursor_epoch } }
 *   C. STRIPE_SUBSCRIPTION_RECOVERY_HOURS=0   → gap check disabled entirely
 *   D. No _sync_status row for subscriptions  → skip conservatively (no calls)
 *   E. cursor_epoch is NULL, updated_at stale → falls back to MAX(created)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Shared mutable state — set by each test before boot().
// vi.hoisted() ensures these run before any vi.mock() factory.
// ---------------------------------------------------------------------------
const {
  dbResponses,
  stripeSyncMock,
} = vi.hoisted(() => {
  const dbResponses: Array<{ rows: unknown[] }> = [];

  const stripeSyncMock = {
    findOrCreateManagedWebhook: vi.fn().mockResolvedValue(undefined),
    syncBackfill: vi.fn().mockResolvedValue(undefined),
    syncCustomers: vi.fn().mockResolvedValue(undefined),
    syncSubscriptions: vi.fn().mockResolvedValue(undefined),
  };

  return { dbResponses, stripeSyncMock };
});

// ---------------------------------------------------------------------------
// Module mocks — hoisted before any import
// ---------------------------------------------------------------------------

vi.mock("stripe", () => {
  class MockStripe {
    balance = {
      retrieve: vi.fn().mockResolvedValue({ object: "balance", available: [], pending: [] }),
    };
    static errors = {
      StripeAuthenticationError: class extends Error { name = "StripeAuthenticationError"; },
      StripeConnectionError: class extends Error { name = "StripeConnectionError"; },
    };
  }
  return { default: MockStripe };
});

vi.mock("stripe-replit-sync", () => ({
  runMigrations: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/stripeClient", () => ({
  getStripeCredentials: vi.fn().mockResolvedValue({
    secretKey: "sk_test_xyz",
    source: "direct-secret",
  }),
  probeStripeKey: vi.fn().mockResolvedValue({ ok: true, authError: false }),
  getStripeSync: vi.fn().mockResolvedValue(stripeSyncMock),
  getUncachableStripeClient: vi.fn(),
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../lib/liveSocket", () => ({
  attachLiveSocketServer: vi.fn(),
}));

vi.mock("../lib/liveStream", () => ({
  liveStreamRegistry: { startCleanupTimer: vi.fn() },
  checkTurnAvailability: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../routes/highlights", () => ({ resumeHighlightJob: vi.fn() }));
vi.mock("../routes/lowlights", () => ({ resumeLowlightJob: vi.fn() }));

vi.mock("../lib/seed", () => ({
  seedDatabase: vi.fn().mockResolvedValue(undefined),
  applyVideoOffsetFixes: vi.fn().mockResolvedValue(undefined),
  applySchemaAdditions: vi.fn().mockResolvedValue(undefined),
}));

// @workspace/db — execute() dequeues from dbResponses so each test controls
// the exact sequence of results.
vi.mock("@workspace/db", () => {
  const execute = vi.fn().mockImplementation(() => {
    const next = dbResponses.shift();
    if (!next) {
      return Promise.reject(
        new Error("stripeGapRecovery.test: unexpected extra db.execute() call"),
      );
    }
    return Promise.resolve(next);
  });
  return {
    db: { execute },
    sql: vi.fn(
      (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
    ),
  };
});

// App — capture listen calls without binding a real port.
const listenMock = vi.fn();
vi.mock("../app", () => ({
  default: {
    listen: listenMock,
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Unix epoch N hours in the past (seconds). */
function epochHoursAgo(hours: number): number {
  return Math.floor(Date.now() / 1000) - hours * 3600;
}

/** Standard db.execute responses for the three guards that precede tier 3. */
function preambleResponses() {
  return [
    { rows: [{ tbl: "stripe.accounts" }] }, // schema check
    { rows: [{ "1": 1 }] },                  // products non-empty
    { rows: [{ "1": 1 }] },                  // subscriptions non-empty
  ];
}

/** Boots the server and waits for all async work to settle. */
async function boot() {
  try {
    await import("../index");
  } catch {
    // process.exit throws in some branches; ignore.
  }
  // Let all microtasks + one macrotask settle.
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

const REQUIRED_ENV: Record<string, string> = {
  PORT: "3001",
  DATABASE_URL: "postgres://localhost/test",
  NODE_ENV: "test",
};

beforeEach(() => {
  // Reset the db response queue and sync-call mocks.
  dbResponses.length = 0;
  stripeSyncMock.syncCustomers.mockClear();
  stripeSyncMock.syncSubscriptions.mockClear();
  stripeSyncMock.syncBackfill.mockClear();
  listenMock.mockReset();
  listenMock.mockImplementation((_port: number, cb?: () => void) => {
    if (cb) cb();
    return { on: vi.fn(), once: vi.fn() };
  });

  for (const [k, v] of Object.entries(REQUIRED_ENV)) {
    process.env[k] = v;
  }

  vi.resetModules();
});

afterEach(() => {
  for (const k of Object.keys(REQUIRED_ENV)) {
    delete process.env[k];
  }
  delete process.env["STRIPE_SUBSCRIPTION_RECOVERY_HOURS"];
});

// ---------------------------------------------------------------------------
// Scenario A: updated_at is recent — skip (no Stripe API calls)
// ---------------------------------------------------------------------------
describe("initStripe() gap-recovery guard (tier 3)", () => {
  it("A — skips recovery when _sync_status.updated_at is within the threshold", async () => {
    // Use strings to mirror real node-postgres driver behaviour for numeric fields.
    dbResponses.push(
      ...preambleResponses(),
      {
        rows: [
          {
            last_sync_epoch: String(epochHoursAgo(2)),
            cursor_epoch: String(epochHoursAgo(2)),
          },
        ],
      },
    );

    await boot();

    expect(stripeSyncMock.syncCustomers).not.toHaveBeenCalled();
    expect(stripeSyncMock.syncSubscriptions).not.toHaveBeenCalled();
    expect(stripeSyncMock.syncBackfill).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Scenario B: updated_at is stale — targeted recovery fires
  // Values are returned as STRINGS to mirror real node-postgres behaviour for
  // numeric/bigint columns, confirming that Number() coercion handles them.
  // ---------------------------------------------------------------------------
  it("B — runs targeted sync with { created: { gt: cursor_epoch } } when updated_at is beyond threshold", async () => {
    const cursorEpoch = epochHoursAgo(30);

    dbResponses.push(
      ...preambleResponses(),
      {
        rows: [
          {
            // Use string values — node-postgres returns numeric/bigint as strings
            // in some configurations. Number() coercion must handle this.
            last_sync_epoch: String(epochHoursAgo(25)),
            cursor_epoch: String(cursorEpoch),
          },
        ],
      },
    );

    await boot();

    expect(stripeSyncMock.syncCustomers).toHaveBeenCalledTimes(1);
    expect(stripeSyncMock.syncCustomers).toHaveBeenCalledWith({
      created: { gt: cursorEpoch },
    });
    expect(stripeSyncMock.syncSubscriptions).toHaveBeenCalledTimes(1);
    expect(stripeSyncMock.syncSubscriptions).toHaveBeenCalledWith({
      created: { gt: cursorEpoch },
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario C: STRIPE_SUBSCRIPTION_RECOVERY_HOURS=0 — check disabled
  // ---------------------------------------------------------------------------
  it("C — skips gap check entirely when STRIPE_SUBSCRIPTION_RECOVERY_HOURS=0", async () => {
    process.env["STRIPE_SUBSCRIPTION_RECOVERY_HOURS"] = "0";

    // Only the three preamble calls — the _sync_status query must NOT fire.
    dbResponses.push(...preambleResponses());

    await boot();

    expect(stripeSyncMock.syncCustomers).not.toHaveBeenCalled();
    expect(stripeSyncMock.syncSubscriptions).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Scenario D: no _sync_status row — skip conservatively
  // ---------------------------------------------------------------------------
  it("D — skips recovery conservatively when no _sync_status row exists", async () => {
    dbResponses.push(
      ...preambleResponses(),
      { rows: [] }, // _sync_status: no row
    );

    await boot();

    expect(stripeSyncMock.syncCustomers).not.toHaveBeenCalled();
    expect(stripeSyncMock.syncSubscriptions).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Scenario E: cursor_epoch is NULL, updated_at stale — falls back to MAX(created)
  // ---------------------------------------------------------------------------
  it("E — falls back to MAX(created) when cursor_epoch is NULL and sync is stale", async () => {
    const maxCreatedEpoch = epochHoursAgo(28);

    dbResponses.push(
      ...preambleResponses(),
      {
        rows: [
          {
            // Strings to mirror real node-postgres driver behaviour.
            last_sync_epoch: String(epochHoursAgo(25)),
            cursor_epoch: null, // NULL from DB — triggers MAX(created) fallback
          },
        ],
      },
      // MAX(created) also returned as string (integer column via bigint driver path).
      { rows: [{ max_created: String(maxCreatedEpoch) }] },
    );

    await boot();

    expect(stripeSyncMock.syncCustomers).toHaveBeenCalledTimes(1);
    expect(stripeSyncMock.syncCustomers).toHaveBeenCalledWith({
      created: { gt: maxCreatedEpoch },
    });
    expect(stripeSyncMock.syncSubscriptions).toHaveBeenCalledTimes(1);
    expect(stripeSyncMock.syncSubscriptions).toHaveBeenCalledWith({
      created: { gt: maxCreatedEpoch },
    });
  });
});
