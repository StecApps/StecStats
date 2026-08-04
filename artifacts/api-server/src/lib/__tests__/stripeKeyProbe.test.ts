/**
 * Tests for the Stripe key probe and boot-time shutdown behaviour.
 *
 * Two areas are covered:
 *
 * 1. probeStripeKey() unit tests
 *    - StripeAuthenticationError  → { ok: false, authError: true }
 *    - Network timeout / generic  → { ok: false, authError: false }
 *    - Successful retrieve()      → { ok: true }
 *
 * 2. Boot-time decision tests (NODE_ENV=production)
 *    - Auth error returned by probe → process.exit(1) called, app.listen NOT called
 *    - Non-auth error (timeout)     → app.listen IS called (server continues booting)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Stripe mock
//
// mockRetrieve.impl is swapped per-test to control what balance.retrieve does.
// Using a real class (not vi.fn()) ensures `new Stripe(key)` behaves exactly
// like the real constructor and is not subject to vi.fn() constructor quirks.
// ---------------------------------------------------------------------------

// vi.hoisted() runs before vi.mock() factories, so everything defined here is
// safe to reference inside the factory below.
const { mockRetrieve, MockStripeAuthenticationError, MockStripeConnectionError } = vi.hoisted(() => {
  class MockStripeAuthenticationError extends Error {
    constructor(raw: { message: string }) {
      super(raw.message);
      this.name = "StripeAuthenticationError";
    }
  }

  class MockStripeConnectionError extends Error {
    constructor(raw: { message: string }) {
      super(raw.message);
      this.name = "StripeConnectionError";
    }
  }

  return {
    mockRetrieve: {
      impl: async (): Promise<object> => ({ available: [], pending: [], livemode: false, object: "balance" }),
    },
    MockStripeAuthenticationError,
    MockStripeConnectionError,
  };
});

vi.mock("stripe", () => {
  // Using a real class guarantees `new MockStripe(key)` works as a constructor.
  class MockStripe {
    balance = {
      retrieve: () => mockRetrieve.impl(),
    };

    // Static errors namespace used by probeStripeKey() for instanceof checks.
    static errors = {
      StripeAuthenticationError: MockStripeAuthenticationError,
      StripeConnectionError: MockStripeConnectionError,
    };
  }

  return { default: MockStripe };
});

// Suppress logger noise in test output.
vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Real import (after mocks are registered)
// ---------------------------------------------------------------------------
import { probeStripeKey } from "../stripeClient";

// ---------------------------------------------------------------------------
// probeStripeKey() — unit tests
// ---------------------------------------------------------------------------

describe("probeStripeKey()", () => {
  describe("success path", () => {
    it("returns { ok: true } when balance.retrieve() resolves", async () => {
      mockRetrieve.impl = async () => ({
        available: [],
        pending: [],
        livemode: true,
        object: "balance",
      });

      const result = await probeStripeKey("sk_test_valid");

      expect(result.ok).toBe(true);
      expect(result.authError).toBe(false);
    });
  });

  describe("authentication error path", () => {
    it("returns { ok: false, authError: true } for StripeAuthenticationError", async () => {
      mockRetrieve.impl = async () => {
        throw new MockStripeAuthenticationError({ message: "No such API key." });
      };

      const result = await probeStripeKey("sk_test_revoked");

      expect(result.ok).toBe(false);
      expect(result.authError).toBe(true);
      expect(result.message).toContain("No such API key.");
    });

    it("includes the Stripe error message in the result", async () => {
      const customMsg = "Invalid API Key provided: sk_test_***";
      mockRetrieve.impl = async () => {
        throw new MockStripeAuthenticationError({ message: customMsg });
      };

      const result = await probeStripeKey("sk_test_bad");

      expect(result.message).toBe(customMsg);
    });
  });

  describe("transient / non-auth error path", () => {
    it("returns { ok: false, authError: false } for a generic network error", async () => {
      mockRetrieve.impl = async () => {
        throw new Error("Request timed out.");
      };

      const result = await probeStripeKey("sk_test_valid");

      expect(result.ok).toBe(false);
      expect(result.authError).toBe(false);
      expect(result.message).toContain("timed out");
    });

    it("returns authError:false for StripeConnectionError (network-level, not auth)", async () => {
      mockRetrieve.impl = async () => {
        throw new MockStripeConnectionError({ message: "Connection refused." });
      };

      const result = await probeStripeKey("sk_test_valid");

      expect(result.ok).toBe(false);
      expect(result.authError).toBe(false);
      expect(result.message).toContain("Connection refused");
    });

    it("returns authError:false for a non-Error thrown value", async () => {
      mockRetrieve.impl = async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw "unexpected string error";
      };

      const result = await probeStripeKey("sk_test_valid");

      expect(result.ok).toBe(false);
      expect(result.authError).toBe(false);
      expect(result.message).toBe("unexpected string error");
    });
  });
});

// ---------------------------------------------------------------------------
// Boot-time shutdown tests
//
// index.ts calls boot() immediately at module load, so we must:
//   1. Set up all required env vars before the dynamic import.
//   2. Reset modules between tests so each import runs a fresh boot().
//   3. Spy on process.exit and make it throw so boot execution actually stops.
//      (A no-op mock lets boot continue past exit() and call app.listen.)
//   4. Track whether app.listen was called.
// ---------------------------------------------------------------------------

describe("boot-time Stripe probe (NODE_ENV=production)", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let listenMock: ReturnType<typeof vi.fn>;

  const REQUIRED_ENV: Record<string, string> = {
    NODE_ENV: "production",
    PORT: "9999",
    DATABASE_URL: "postgres://localhost/test",
    STRIPE_SECRET_KEY: "sk_test_boot_probe",
    STRIPE_WEBHOOK_SECRET: "whsec_boot_probe",
    REVENUECAT_WEBHOOK_SECRET: "rc_boot_probe",
    REPLIT_DOMAINS: "test.example.com",
  };

  beforeEach(() => {
    listenMock = vi.fn();

    // Make process.exit throw on the FIRST call so boot() actually stops
    // before reaching app.listen(). The outer `boot().catch(→ process.exit)`
    // handler calls it a second time; the second call is a silent no-op so
    // the promise settles cleanly.
    let firstExit = true;
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code: number) => {
      if (firstExit) {
        firstExit = false;
        throw new Error(`process.exit(${code})`);
      }
      // Second call (from the outer catch) — do not throw; let it settle.
    }) as () => never);

    for (const [k, v] of Object.entries(REQUIRED_ENV)) {
      process.env[k] = v;
    }

    // Each test needs a fresh module graph so boot() side-effects re-run.
    vi.resetModules();
  });

  afterEach(() => {
    exitSpy.mockRestore();
    for (const k of Object.keys(REQUIRED_ENV)) {
      delete process.env[k];
    }
  });

  /**
   * Register all mocks for a boot-time import.
   * probeResult controls what probeStripeKey() returns.
   */
  function registerBootMocks(probeResult: { ok: boolean; authError: boolean; message?: string }) {
    // stripeClient — control the probe result per test.
    vi.doMock("../../lib/stripeClient", () => ({
      getStripeCredentials: vi.fn().mockResolvedValue({
        secretKey: "sk_test_boot_probe",
        source: "direct-secret",
      }),
      probeStripeKey: vi.fn().mockResolvedValue(probeResult),
      getStripeSync: vi.fn().mockResolvedValue({
        findOrCreateManagedWebhook: vi.fn().mockResolvedValue(undefined),
        syncBackfill: vi.fn().mockResolvedValue(undefined),
        syncCustomers: vi.fn().mockResolvedValue(undefined),
        syncSubscriptions: vi.fn().mockResolvedValue(undefined),
      }),
      getUncachableStripeClient: vi.fn(),
    }));

    // Express app — capture listen calls.
    vi.doMock("../../app", () => ({
      default: {
        listen: listenMock.mockImplementation((_port: number, cb?: () => void) => {
          if (cb) cb();
          return { on: vi.fn(), once: vi.fn() };
        }),
      },
    }));

    // stripe-replit-sync
    vi.doMock("stripe-replit-sync", () => ({
      runMigrations: vi.fn().mockResolvedValue(undefined),
    }));

    // @workspace/db
    vi.doMock("@workspace/db", () => ({
      db: {
        execute: vi.fn().mockResolvedValue({ rows: [{ tbl: "stripe.accounts" }] }),
      },
      sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values })),
    }));

    // Silence the logger.
    vi.doMock("../../lib/logger", () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));

    // Lightweight stubs for everything else boot() touches.
    vi.doMock("../../lib/liveSocket", () => ({
      attachLiveSocketServer: vi.fn(),
    }));
    vi.doMock("../../lib/liveStream", () => ({
      liveStreamRegistry: { startCleanupTimer: vi.fn() },
      checkTurnAvailability: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock("../../routes/highlights", () => ({
      resumeHighlightJob: vi.fn(),
    }));
    vi.doMock("../../routes/lowlights", () => ({
      resumeLowlightJob: vi.fn(),
    }));
    vi.doMock("../../lib/seed", () => ({
      seedDatabase: vi.fn().mockResolvedValue(undefined),
      applyVideoOffsetFixes: vi.fn().mockResolvedValue(undefined),
    }));
  }

  it("calls process.exit(1) and does NOT call app.listen when the probe returns an auth error", async () => {
    registerBootMocks({ ok: false, authError: true, message: "No such API key." });

    // Dynamically import so boot() runs with our mocks active.
    // process.exit throws on first call, so boot() throws → the outer
    // boot().catch handler calls exit again (no-op) → import settles.
    try {
      await import("../../index");
    } catch {
      // Expected: process.exit throws to halt boot execution.
    }

    // Allow any remaining microtasks to flush.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    // The fatal auth-error branch must have called process.exit(1).
    expect(exitSpy).toHaveBeenCalledWith(1);

    // Crucially: app.listen must NOT have been called — the server must not
    // have accepted any connections before the exit.
    expect(listenMock).not.toHaveBeenCalled();
  });

  it("does NOT call process.exit and calls app.listen when probe returns a non-auth (transient) error", async () => {
    registerBootMocks({ ok: false, authError: false, message: "Request timed out." });

    try {
      await import("../../index");
    } catch {
      // Unexpected for the non-auth case; let assertions below surface the problem.
    }

    // Flush async work.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    // Non-auth errors are transient: the server must continue booting.
    expect(exitSpy).not.toHaveBeenCalled();

    // The server should have bound its port.
    expect(listenMock).toHaveBeenCalled();
  });

  it("calls process.exit(1) and does NOT call app.listen when a sk_test_ key passes probe in production", async () => {
    // The probe succeeds (the key is technically valid) but the key begins with
    // sk_test_ — deploying a test key to production means real payments are
    // never settled.  The boot guard must catch this and refuse to open the port.
    registerBootMocks({ ok: true, authError: false });

    // Spy on console.error so we can assert the [FATAL] message is emitted.
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await import("../../index");
    } catch {
      // Expected: process.exit throws to halt boot execution.
    }

    // Flush any remaining microtasks.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    // Must have exited with code 1.
    expect(exitSpy).toHaveBeenCalledWith(1);

    // Must NOT have opened the port — server should never accept connections.
    expect(listenMock).not.toHaveBeenCalled();

    // The [FATAL] message about the test key must appear in stderr.
    const stderrCalls = consoleErrorSpy.mock.calls.flat().join("\n");
    expect(stderrCalls).toMatch(/\[FATAL\]/);
    expect(stderrCalls).toMatch(/sk_test_/);

    consoleErrorSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Boot-time development test-key warning
//
// index.ts emits TWO lines when NODE_ENV !== "production" and STRIPE_SECRET_KEY
// starts with "sk_test_":
//   1. logger.warn(stripeTestKeyMsg)         ← structured log
//   2. console.warn("[WARN] " + stripeTestKeyMsg)  ← plain-text fallback
//
// These tests verify both lines appear so a future refactor cannot silently
// drop either one.
// ---------------------------------------------------------------------------

describe("boot-time Stripe test-key warning (NODE_ENV=development)", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let listenMock: ReturnType<typeof vi.fn>;
  let loggerWarnSpy: ReturnType<typeof vi.fn>;

  const BASE_ENV: Record<string, string> = {
    NODE_ENV: "development",
    PORT: "9998",
    DATABASE_URL: "postgres://localhost/test",
    REVENUECAT_WEBHOOK_SECRET: "rc_dev_probe",
    SESSION_SECRET: "session_dev_probe",
    CLERK_SECRET_KEY: "clerk_dev_probe",
    REPLIT_DOMAINS: "test.example.com",
  };

  beforeEach(() => {
    listenMock = vi.fn();
    loggerWarnSpy = vi.fn();

    // process.exit must not actually exit — make the first call a no-op so
    // boot() can settle without killing the test runner.
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as () => never);

    for (const [k, v] of Object.entries(BASE_ENV)) {
      process.env[k] = v;
    }

    vi.resetModules();
  });

  afterEach(() => {
    exitSpy.mockRestore();
    for (const k of Object.keys(BASE_ENV)) {
      delete process.env[k];
    }
    delete process.env["STRIPE_SECRET_KEY"];
  });

  /** Register all mocks needed for a dev-mode boot. */
  function registerDevBootMocks() {
    vi.doMock("../../lib/stripeClient", () => ({
      getStripeCredentials: vi.fn().mockResolvedValue({
        secretKey: "sk_test_dev_key",
        source: "direct-secret",
      }),
      probeStripeKey: vi.fn().mockResolvedValue({ ok: true, authError: false }),
      getStripeSync: vi.fn().mockResolvedValue({
        findOrCreateManagedWebhook: vi.fn().mockResolvedValue(undefined),
        syncBackfill: vi.fn().mockResolvedValue(undefined),
        syncCustomers: vi.fn().mockResolvedValue(undefined),
        syncSubscriptions: vi.fn().mockResolvedValue(undefined),
      }),
      getUncachableStripeClient: vi.fn(),
    }));

    vi.doMock("../../app", () => ({
      default: {
        listen: listenMock.mockImplementation((_port: number, cb?: () => void) => {
          if (cb) cb();
          return { on: vi.fn(), once: vi.fn() };
        }),
      },
    }));

    vi.doMock("stripe-replit-sync", () => ({
      runMigrations: vi.fn().mockResolvedValue(undefined),
    }));

    vi.doMock("@workspace/db", () => ({
      db: {
        execute: vi.fn().mockResolvedValue({ rows: [{ tbl: "stripe.accounts" }] }),
      },
      sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values })),
    }));

    // Capture logger.warn calls so we can assert the structured log line.
    vi.doMock("../../lib/logger", () => ({
      logger: {
        info: vi.fn(),
        warn: loggerWarnSpy,
        error: vi.fn(),
        debug: vi.fn(),
      },
    }));

    vi.doMock("../../lib/liveSocket", () => ({
      attachLiveSocketServer: vi.fn(),
    }));
    vi.doMock("../../lib/liveStream", () => ({
      liveStreamRegistry: { startCleanupTimer: vi.fn() },
      checkTurnAvailability: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock("../../routes/highlights", () => ({
      resumeHighlightJob: vi.fn(),
    }));
    vi.doMock("../../routes/lowlights", () => ({
      resumeLowlightJob: vi.fn(),
    }));
    vi.doMock("../../lib/seed", () => ({
      seedDatabase: vi.fn().mockResolvedValue(undefined),
      applyVideoOffsetFixes: vi.fn().mockResolvedValue(undefined),
    }));
  }

  it("emits the structured logger.warn line when a sk_test_ key is set in development", async () => {
    process.env["STRIPE_SECRET_KEY"] = "sk_test_dev_key_123";
    registerDevBootMocks();

    try {
      await import("../../index");
    } catch {
      // Unexpected in dev mode; let assertions surface any real failure.
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    // logger.warn must have been called with a message containing the marker.
    const warnCalls = loggerWarnSpy.mock.calls.flat().join("\n");
    expect(warnCalls).toMatch(/Stripe test key \(sk_test_\)/);
  });

  it("emits the console.warn [WARN] line when a sk_test_ key is set in development", async () => {
    process.env["STRIPE_SECRET_KEY"] = "sk_test_dev_key_123";
    registerDevBootMocks();

    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await import("../../index");
    } catch {
      // Unexpected in dev mode.
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    const warnOutput = consoleWarnSpy.mock.calls.flat().join("\n");
    expect(warnOutput).toMatch(/\[WARN\]/);
    expect(warnOutput).toMatch(/Stripe test key \(sk_test_\)/);

    consoleWarnSpy.mockRestore();
  });

  it("does NOT emit the test-key warning when no STRIPE_SECRET_KEY is set", async () => {
    // STRIPE_SECRET_KEY deliberately absent — no warning should fire.
    delete process.env["STRIPE_SECRET_KEY"];
    registerDevBootMocks();

    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await import("../../index");
    } catch {
      // Unexpected.
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    // Neither the structured log nor the plain-text line should mention sk_test_.
    const warnCalls = loggerWarnSpy.mock.calls.flat().join("\n");
    expect(warnCalls).not.toMatch(/Stripe test key \(sk_test_\)/);

    const consoleWarnOutput = consoleWarnSpy.mock.calls.flat().join("\n");
    expect(consoleWarnOutput).not.toMatch(/Stripe test key \(sk_test_\)/);

    consoleWarnSpy.mockRestore();
  });

  it("does NOT emit the test-key warning when a sk_live_ key is used in development", async () => {
    process.env["STRIPE_SECRET_KEY"] = "sk_live_some_live_key_456";
    registerDevBootMocks();

    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await import("../../index");
    } catch {
      // Unexpected.
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    const warnCalls = loggerWarnSpy.mock.calls.flat().join("\n");
    expect(warnCalls).not.toMatch(/Stripe test key \(sk_test_\)/);

    const consoleWarnOutput = consoleWarnSpy.mock.calls.flat().join("\n");
    expect(consoleWarnOutput).not.toMatch(/Stripe test key \(sk_test_\)/);

    consoleWarnSpy.mockRestore();
  });
});
