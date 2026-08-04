/**
 * requireAuth — per-request DB read guarantee
 *
 * The comment block at the top of requireAuth.ts explicitly forbids caching
 * the `users` row in a session store. This test pins that contract by directly
 * spying on `db.query.usersTable.findFirst` and asserting it is called once on
 * every invocation of the middleware — even when the same Clerk session fires
 * two back-to-back requests.
 *
 * If a future developer wraps the lookup in a session cache, `findFirst` will
 * be skipped on the second (and subsequent) calls, and these tests will fail
 * loudly — before any integration test gets a chance to miss it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

// ---------------------------------------------------------------------------
// vi.hoisted() — runs before vi.mock() factories, so refs are available there.
// ---------------------------------------------------------------------------
const { mockUser, findFirstMock, getAuthMock } = vi.hoisted(() => {
  const mockUser = {
    id: 42,
    clerkUserId: "clerk_test_session_001",
    email: "coach@example.com",
    stripeCustomerId: null as string | null,
    youtubeRefreshToken: null as string | null,
    revenueCatEntitlement: null as string | null,
    createdAt: new Date(),
  };

  const findFirstMock = vi.fn().mockImplementation(async () => ({ ...mockUser }));

  // Kept in hoisted scope so it can be overridden per-test via mockReturnValueOnce.
  const getAuthMock = vi.fn().mockReturnValue({ userId: mockUser.clerkUserId });

  return { mockUser, findFirstMock, getAuthMock };
});

// ---------------------------------------------------------------------------
// Module mocks — declared before any imports that resolve them.
// ---------------------------------------------------------------------------

// Clerk: getAuth always returns the test session via getAuthMock.
// clerkClient.users.getUser is never called because the mock user already
// has an email stored in the DB row (findFirst returns it).
vi.mock("@clerk/express", () => ({
  getAuth: getAuthMock,
  clerkClient: {
    users: {
      getUser: vi.fn().mockResolvedValue({
        emailAddresses: [{ id: "ea_1", emailAddress: mockUser.email }],
        primaryEmailAddressId: "ea_1",
      }),
    },
  },
}));

// DB: findFirstMock is the spy under test. Insert/update/select are mocked so
// the middleware can run to completion without a real database.
vi.mock("@workspace/db", () => {
  // Minimal column stubs — the mock WHERE predicate is ignored.
  const usersTable   = { clerkUserId: "clerkUserId", id: "id", email: "email", ownerId: "ownerId" };
  const playersTable = { id: "id", ownerId: "ownerId" };
  const teamsTable   = { id: "id", ownerId: "ownerId" };
  const gamesTable   = { id: "id", ownerId: "ownerId" };

  return {
    db: {
      query: {
        usersTable: {
          findFirst: findFirstMock,
        },
      },
      // insert() — not triggered in the happy path (findFirst returns a user).
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ ...mockUser }]),
          }),
        }),
      }),
      // update() — not triggered in the happy path.
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      }),
      // Legacy-backfill owner-check: return [] so the branch is a no-op.
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              union: vi.fn().mockReturnValue({
                union: vi.fn().mockResolvedValue([]),
              }),
            }),
          }),
        }),
      }),
      transaction: vi.fn(),
    },
    usersTable,
    playersTable,
    teamsTable,
    gamesTable,
  };
});

// drizzle-orm helpers used in requireAuth
vi.mock("drizzle-orm", () => ({
  eq:     vi.fn((_col: unknown, _val: unknown) => ({})),
  isNull: vi.fn((_col: unknown) => ({})),
}));

// ---------------------------------------------------------------------------
// Real import (after mocks are registered)
// ---------------------------------------------------------------------------
import { requireAuth } from "../requireAuth";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockReq(overrides: Partial<Request> = {}): Request {
  return {
    log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
    ...overrides,
  } as unknown as Request;
}

function makeMockRes(): Response {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json   = vi.fn().mockReturnValue(res);
  return res as Response;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("requireAuth — per-request DB read contract", () => {
  beforeEach(() => {
    // Reset call counts only — do not wipe mock implementations.
    vi.clearAllMocks();

    // Re-apply happy-path implementations that clearAllMocks may have cleared.
    findFirstMock.mockImplementation(async () => ({ ...mockUser }));
    getAuthMock.mockReturnValue({ userId: mockUser.clerkUserId });

    delete process.env["OWNER_CLERK_EMAIL"];
  });

  // -------------------------------------------------------------------------
  // 1. Single request — findFirst is called exactly once
  // -------------------------------------------------------------------------
  it("calls db.query.usersTable.findFirst exactly once per request", async () => {
    const req  = makeMockReq();
    const res  = makeMockRes();
    const next = vi.fn() as NextFunction;

    await requireAuth(req, res, next);

    expect(findFirstMock).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 2. Two sequential requests from the same Clerk session — findFirst is
  //    called once per request, never skipped on the second call.
  //    This is the core regression guard: if a session cache is introduced,
  //    findFirst will return call-count 1 on the second request and this
  //    assertion will fail.
  // -------------------------------------------------------------------------
  it("calls db.query.usersTable.findFirst on every request — not just the first", async () => {
    const next = vi.fn() as NextFunction;

    // First request
    const req1 = makeMockReq();
    const res1 = makeMockRes();
    await requireAuth(req1, res1, next);
    expect(findFirstMock).toHaveBeenCalledTimes(1);

    // Second request — same Clerk session, different req/res objects
    const req2 = makeMockReq();
    const res2 = makeMockRes();
    await requireAuth(req2, res2, next);

    // Must be 2 — one per invocation, never cached.
    expect(findFirstMock).toHaveBeenCalledTimes(2);
    expect(next).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // 3. Five sequential requests — findFirst count equals request count,
  //    proving no per-process or per-session caching is happening.
  // -------------------------------------------------------------------------
  it("calls db.query.usersTable.findFirst N times for N sequential requests", async () => {
    const N = 5;
    for (let i = 0; i < N; i++) {
      const req  = makeMockReq();
      const res  = makeMockRes();
      const next = vi.fn() as NextFunction;
      await requireAuth(req, res, next);
    }

    expect(findFirstMock).toHaveBeenCalledTimes(N);
  });

  // -------------------------------------------------------------------------
  // 4. req.appUser is populated with the fresh DB row on every request,
  //    ensuring downstream handlers always see the current entitlement.
  // -------------------------------------------------------------------------
  it("attaches the DB-fetched user to req.appUser on every request", async () => {
    const req  = makeMockReq();
    const res  = makeMockRes();
    const next = vi.fn() as NextFunction;

    await requireAuth(req, res, next);

    expect(req.appUser).toBeDefined();
    expect(req.appUser?.id).toBe(mockUser.id);
    expect(req.appUser?.clerkUserId).toBe(mockUser.clerkUserId);
  });

  // -------------------------------------------------------------------------
  // 5. Expiry propagation: if findFirst returns a user with a null
  //    entitlement on the second request (simulating a webhook clearing the
  //    DB row between requests), req.appUser reflects the cleared state —
  //    not a cached "pro" value.
  // -------------------------------------------------------------------------
  it("reflects a revoked entitlement on the very next request without a server restart", async () => {
    // First request: user is "pro"
    findFirstMock.mockResolvedValueOnce({ ...mockUser, revenueCatEntitlement: "pro" });

    const req1  = makeMockReq();
    const res1  = makeMockRes();
    const next1 = vi.fn() as NextFunction;
    await requireAuth(req1, res1, next1);
    expect(req1.appUser?.revenueCatEntitlement).toBe("pro");

    // A webhook fires between the two requests and clears the DB row.
    // Second request: findFirst returns the post-webhook state (null).
    findFirstMock.mockResolvedValueOnce({ ...mockUser, revenueCatEntitlement: null });

    const req2  = makeMockReq();
    const res2  = makeMockRes();
    const next2 = vi.fn() as NextFunction;
    await requireAuth(req2, res2, next2);

    // Must see null — not the cached "pro" from the first request.
    expect(req2.appUser?.revenueCatEntitlement).toBeNull();
    expect(findFirstMock).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // 6. Missing Clerk session → 401, findFirst never called
  // -------------------------------------------------------------------------
  it("returns 401 and does not call findFirst when there is no Clerk session", async () => {
    getAuthMock.mockReturnValueOnce({ userId: null });

    const req  = makeMockReq();
    const res  = makeMockRes();
    const next = vi.fn() as NextFunction;

    await requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(findFirstMock).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
});
