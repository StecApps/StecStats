/**
 * GET /live/ice-servers — integration test
 *
 * Verifies that the endpoint:
 *   1. Always returns `iceServers` and `turnAvailable` fields.
 *   2. Returns `turnAvailable: false` when METERED_API_KEY / METERED_DOMAIN
 *      are absent (STUN-only fallback).
 *   3. Returns `turnAvailable: false` when the Metered.ca credential fetch
 *      fails (non-2xx or network error).
 *   4. Returns `turnAvailable: true` when Metered.ca returns at least one
 *      TURN server.
 *
 * `getIceServers` in liveStream.ts uses module-level cache + module-level
 * `turnAvailable` state.  To keep tests independent we clear the cache
 * between cases by backdating it (setting expiresAt to 0) via the module's
 * internal reference, which vitest exposes through importActual.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";

// ---------------------------------------------------------------------------
// Minimal mocks for modules that liveStream.ts / live.ts import but that
// the /ice-servers endpoint doesn't actually exercise.
// ---------------------------------------------------------------------------

vi.mock("@workspace/db", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
    }),
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([]),
    }),
    query: {
      liveSessionsTable: { findFirst: vi.fn() },
    },
  },
  liveSessionsTable: {},
}));

vi.mock("../../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../../middlewares/requireAuth", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../../lib/entitlements", () => ({
  getEntitlements: vi.fn().mockResolvedValue({ plan: "premium" }),
  isPro: vi.fn().mockReturnValue(true),
}));

// ---------------------------------------------------------------------------
// Real imports (after mocks are registered)
// ---------------------------------------------------------------------------
import liveRouter from "../live";
import { _testResetIceCache } from "../../lib/liveStream";

// ---------------------------------------------------------------------------
// TURN server fixtures
// ---------------------------------------------------------------------------
const METERED_TURN_RESPONSE = [
  { urls: "stun:global.stun.twilio.com:3478" },
  {
    urls: "turn:global.relay.metered.ca:80",
    username: "test-user",
    credential: "test-cred",
  },
  {
    urls: "turns:global.relay.metered.ca:443",
    username: "test-user",
    credential: "test-cred",
  },
];

/** A second credential set with different username/credential values,
 *  simulating a fresh Metered.ca issuance after the first set expires. */
const METERED_TURN_RESPONSE_V2 = [
  { urls: "stun:global.stun.twilio.com:3478" },
  {
    urls: "turn:global.relay.metered.ca:80",
    username: "refreshed-user",
    credential: "refreshed-cred",
  },
  {
    urls: "turns:global.relay.metered.ca:443",
    username: "refreshed-user",
    credential: "refreshed-cred",
  },
];

// ---------------------------------------------------------------------------
// Fetch interceptor factory
//
// Intercepts only requests whose URL matches `urlPredicate`; all other
// requests (e.g. the test's own HTTP calls to the Express server) are
// forwarded to the real fetch so they succeed normally.
// ---------------------------------------------------------------------------
function mockMeteredFetch(
  urlPredicate: (url: string) => boolean,
  handler: (url: string) => Response | Promise<Response>,
) {
  const realFetch = globalThis.fetch.bind(globalThis);
  return vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      if (urlPredicate(url)) {
        return handler(url);
      }
      return realFetch(input, init);
    },
  );
}


// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("GET /live/ice-servers", () => {
  let server: Server;
  let baseUrl: string;

  // Save and restore env vars around the whole suite so we never leak state.
  const ORIG_API_KEY = process.env.METERED_API_KEY;
  const ORIG_DOMAIN = process.env.METERED_DOMAIN;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api", liveRouter);

    server = createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}/api`;
  });

  afterAll(async () => {
    // Restore original env vars after the suite.
    if (ORIG_API_KEY === undefined) {
      delete process.env.METERED_API_KEY;
    } else {
      process.env.METERED_API_KEY = ORIG_API_KEY;
    }
    if (ORIG_DOMAIN === undefined) {
      delete process.env.METERED_DOMAIN;
    } else {
      process.env.METERED_DOMAIN = ORIG_DOMAIN;
    }

    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    // Clear env vars AND the in-module cache so each test starts from a clean
    // slate — no stale TURN credentials or cached server lists from a previous
    // test can leak through.
    delete process.env.METERED_API_KEY;
    delete process.env.METERED_DOMAIN;
    _testResetIceCache();
  });

  // -------------------------------------------------------------------------
  // Test 1: no env vars → STUN-only, turnAvailable: false
  // -------------------------------------------------------------------------
  it("returns turnAvailable:false and STUN iceServers when env vars are absent", async () => {
    // Ensure env vars are absent (already done in beforeEach).
    const res = await fetch(`${baseUrl}/live/ice-servers`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;

    // Both fields must always be present.
    expect(body).toHaveProperty("iceServers");
    expect(body).toHaveProperty("turnAvailable");

    expect(body.turnAvailable).toBe(false);

    // Should contain at least one STUN server.
    const iceServers = body.iceServers as Array<{ urls: string | string[] }>;
    expect(Array.isArray(iceServers)).toBe(true);
    expect(iceServers.length).toBeGreaterThan(0);
    const hasTurn = iceServers.some((s) => {
      const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
      return urls.some((u) => u.startsWith("turn:") || u.startsWith("turns:"));
    });
    expect(hasTurn).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 2: env vars set but METERED_API_KEY absent (METERED_DOMAIN only)
  // -------------------------------------------------------------------------
  it("returns turnAvailable:false when only METERED_DOMAIN is set (API key missing)", async () => {
    process.env.METERED_DOMAIN = "global.relay.metered.ca";
    // METERED_API_KEY intentionally absent.

    const res = await fetch(`${baseUrl}/live/ice-servers`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("iceServers");
    expect(body).toHaveProperty("turnAvailable");
    expect(body.turnAvailable).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 3: Metered.ca returns a non-2xx → turnAvailable: false
  // -------------------------------------------------------------------------
  it("returns turnAvailable:false when the Metered.ca credential fetch fails (non-2xx)", async () => {
    process.env.METERED_API_KEY = "bad-key";
    process.env.METERED_DOMAIN = "global.relay.metered.ca";

    // Only intercept calls to the Metered.ca API; let the test's own
    // HTTP request to the local Express server pass through unchanged.
    const fetchSpy = mockMeteredFetch(
      (url) => url.includes("metered.ca"),
      () => new Response(JSON.stringify({ error: "Unauthorized" }), { status: 403 }),
    );

    const res = await fetch(`${baseUrl}/live/ice-servers`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("iceServers");
    expect(body).toHaveProperty("turnAvailable");
    expect(body.turnAvailable).toBe(false);

    fetchSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Test 4: Metered.ca network error → turnAvailable: false
  // -------------------------------------------------------------------------
  it("returns turnAvailable:false when the Metered.ca fetch throws a network error", async () => {
    process.env.METERED_API_KEY = "some-key";
    process.env.METERED_DOMAIN = "global.relay.metered.ca";

    const fetchSpy = mockMeteredFetch(
      (url) => url.includes("metered.ca"),
      () => { throw new Error("ECONNREFUSED"); },
    );

    const res = await fetch(`${baseUrl}/live/ice-servers`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("iceServers");
    expect(body).toHaveProperty("turnAvailable");
    expect(body.turnAvailable).toBe(false);

    fetchSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Test 5: Metered.ca returns valid TURN servers → turnAvailable: true
  // -------------------------------------------------------------------------
  it("returns turnAvailable:true and includes TURN servers when Metered.ca responds successfully", async () => {
    process.env.METERED_API_KEY = "valid-key";
    process.env.METERED_DOMAIN = "global.relay.metered.ca";

    const fetchSpy = mockMeteredFetch(
      (url) => url.includes("metered.ca"),
      () =>
        new Response(JSON.stringify(METERED_TURN_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const res = await fetch(`${baseUrl}/live/ice-servers`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;

    // Both fields always present.
    expect(body).toHaveProperty("iceServers");
    expect(body).toHaveProperty("turnAvailable");

    expect(body.turnAvailable).toBe(true);

    // Response should contain at least one TURN server.
    const iceServers = body.iceServers as Array<{ urls: string | string[] }>;
    expect(Array.isArray(iceServers)).toBe(true);
    const hasTurn = iceServers.some((s) => {
      const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
      return urls.some((u) => u.startsWith("turn:") || u.startsWith("turns:"));
    });
    expect(hasTurn).toBe(true);

    fetchSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Test 6: Metered.ca returns an empty array → turnAvailable: false
  // -------------------------------------------------------------------------
  it("returns turnAvailable:false when Metered.ca responds with an empty server list", async () => {
    process.env.METERED_API_KEY = "valid-key";
    process.env.METERED_DOMAIN = "global.relay.metered.ca";

    const fetchSpy = mockMeteredFetch(
      (url) => url.includes("metered.ca"),
      () =>
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const res = await fetch(`${baseUrl}/live/ice-servers`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("iceServers");
    expect(body).toHaveProperty("turnAvailable");
    expect(body.turnAvailable).toBe(false);

    fetchSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Test 7: cache expires mid-game → fresh credentials from Metered.ca are
  // served on the next request, not the stale cached ones.
  //
  // Scenario: the server issues credentials at game-start (V1).  After 50
  // minutes (TURN_CACHE_TTL_MS) the cache entry expires.  The next call to
  // GET /live/ice-servers must re-fetch from Metered.ca and return the new
  // credentials (V2), not the ones that were valid at the start of the game.
  // -------------------------------------------------------------------------
  it("serves fresh credentials when the cache expires before they are served again", async () => {
    process.env.METERED_API_KEY = "valid-key";
    process.env.METERED_DOMAIN = "global.relay.metered.ca";

    // ── Phase 1: prime the cache with V1 credentials ──────────────────────
    const fetchSpyV1 = mockMeteredFetch(
      (url) => url.includes("metered.ca"),
      () =>
        new Response(JSON.stringify(METERED_TURN_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const res1 = await fetch(`${baseUrl}/live/ice-servers`);
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { iceServers: Array<{ urls: string | string[]; username?: string }> };
    const firstUsername = body1.iceServers.find((s) => s.username)?.username;
    expect(firstUsername).toBe("test-user"); // V1 served

    fetchSpyV1.mockRestore();

    // ── Phase 2: simulate cache expiry (e.g. 50 min have passed mid-game) ─
    _testResetIceCache();

    // ── Phase 3: Metered.ca now issues a fresh credential set (V2) ─────────
    const fetchSpyV2 = mockMeteredFetch(
      (url) => url.includes("metered.ca"),
      () =>
        new Response(JSON.stringify(METERED_TURN_RESPONSE_V2), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const res2 = await fetch(`${baseUrl}/live/ice-servers`);
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { iceServers: Array<{ urls: string | string[]; username?: string }>; turnAvailable: boolean };

    // The endpoint must return the new credentials, not the stale V1 ones.
    const refreshedUsername = body2.iceServers.find((s) => s.username)?.username;
    expect(refreshedUsername).toBe("refreshed-user");
    expect(body2.turnAvailable).toBe(true);

    fetchSpyV2.mockRestore();
  });
});
