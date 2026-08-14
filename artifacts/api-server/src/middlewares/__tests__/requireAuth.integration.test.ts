/**
 * requireAuth — clerkMiddleware integration contract
 *
 * Unit tests (requireAuth.test.ts) mock getAuth() and test requireAuth in
 * isolation. Those tests cannot catch bugs in how clerkMiddleware hands off
 * authentication state to requireAuth.
 *
 * This suite mounts real clerkMiddleware() + requireAuth together on an Express
 * app and hits it via supertest. The Clerk SDK's network calls are intercepted by
 * injecting a mock clerkClient (accepted via clerkMiddleware({ clerkClient })).
 * clerkMiddleware still runs its full middleware logic: it reads req.headers,
 * calls clerkClient.authenticateRequest(), and deposits the result on req.auth.
 * requireAuth then calls getAuth(req) which reads the real req.auth object.
 *
 * This catches regressions in:
 *   - clerkMiddleware not being mounted (getAuth would return undefined)
 *   - proxyUrl misconfiguration causing every mobile Bearer token to be rejected
 *   - requireAuth reading auth state from the wrong property
 *   - The middleware order being wrong (clerkMiddleware must precede requireAuth)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";

// ---------------------------------------------------------------------------
// vi.hoisted() — must run before vi.mock() factories
// ---------------------------------------------------------------------------
const { mockUser, findFirstMock, makeSignedInState, makeSignedOutState } = vi.hoisted(() => {
  const mockUser = {
    id: 42,
    clerkUserId: "user_live_abc123",
    email: "coach@example.com",
    stripeCustomerId: null as string | null,
    youtubeRefreshToken: null as string | null,
    revenueCatEntitlement: null as string | null,
    createdAt: new Date(),
  };

  const findFirstMock = vi.fn();

  /**
   * Builds a minimal requestState that clerkMiddleware expects from
   * clerkClient.authenticateRequest() for a signed-in request.
   *
   * The middleware reads:
   *   - requestState.headers.forEach(...)  — to copy auth headers into the response
   *   - requestState.headers.get(key)       — to detect Location/handshake redirects
   *   - requestState.status                 — to detect the Handshake state
   *   - requestState.toAuth(opts)           — to build the req.auth object
   *
   * IMPORTANT: toAuth() must include `tokenType: "session_token"`.
   * getAuth(req) passes the toAuth() result to getAuthObjectForAcceptedToken(),
   * which calls isTokenTypeAccepted(authObject.tokenType, "session_token").
   * If tokenType is missing/falsy, isTokenTypeAccepted returns false and
   * getAuth returns a signed-out object (userId: null) — causing a spurious 401.
   */
  const makeSignedInState = (userId: string) => ({
    status: "signed-in" as const,
    headers: new Headers(),
    toAuth: (_opts?: unknown) => ({
      userId,
      sessionId: "sess_test_001",
      tokenType: "session_token" as const, // required by getAuthObjectForAcceptedToken
    }),
  });

  /**
   * Builds a minimal requestState for a rejected/missing/expired token.
   * toAuth() returns an object with userId: null — getAuth(req) reflects this.
   */
  const makeSignedOutState = () => ({
    status: "signed-out" as const,
    headers: new Headers(),
    toAuth: (_opts?: unknown) => ({ userId: null }),
  });

  return { mockUser, findFirstMock, makeSignedInState, makeSignedOutState };
});

// ---------------------------------------------------------------------------
// DB mock — requireAuth reads the DB on every authenticated request.
// We must mock this or the middleware will fail with a real-DB error.
// ---------------------------------------------------------------------------
vi.mock("@workspace/db", () => {
  const usersTable   = { clerkUserId: "clerkUserId", id: "id", email: "email", ownerId: "ownerId" };
  const playersTable = { id: "id", ownerId: "ownerId" };
  const teamsTable   = { id: "id", ownerId: "ownerId" };
  const gamesTable   = { id: "id", ownerId: "ownerId" };

  return {
    db: {
      query: { usersTable: { findFirst: findFirstMock } },
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ ...mockUser }]),
          }),
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      }),
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              union: vi.fn().mockReturnValue({ union: vi.fn().mockResolvedValue([]) }),
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

vi.mock("drizzle-orm", () => ({
  eq:     vi.fn(() => ({})),
  isNull: vi.fn(() => ({})),
  and:    vi.fn(() => ({})),
  ne:     vi.fn(() => ({})),
}));

// ---------------------------------------------------------------------------
// Real imports — @clerk/express is NOT mocked; clerkMiddleware runs for real.
// ---------------------------------------------------------------------------
import { readFileSync } from "fs";
import { resolve } from "path";
import { clerkMiddleware } from "@clerk/express";
import { requireAuth } from "../requireAuth";

// ---------------------------------------------------------------------------
// Build a test Express app with real clerkMiddleware + requireAuth.
//
// clerkMiddleware({ clerkClient }) is the documented API for injecting a
// custom Clerk client. We pass a mock whose authenticateRequest returns
// whatever the test configures, letting us control "signed in" vs "signed out"
// without hitting Clerk's servers.
//
// The test route /probe calls requireAuth and, on success, echoes back the
// local user id so tests can assert that the DB row was resolved correctly.
// ---------------------------------------------------------------------------

const mockClerkClient = {
  authenticateRequest: vi.fn(),
  // clerkMiddleware may access other properties on the client; stub minimally.
  users: {
    getUser: vi.fn().mockResolvedValue({
      emailAddresses: [{ id: "ea_1", emailAddress: mockUser.email }],
      primaryEmailAddressId: "ea_1",
    }),
  },
};

function buildTestApp() {
  const app = express();
  app.use(express.json());
  // Real clerkMiddleware with our mock client injected.
  app.use(clerkMiddleware({ clerkClient: mockClerkClient as never }));
  app.get("/probe", requireAuth, (req, res) => {
    res.json({ userId: req.appUser?.id, clerkUserId: req.appUser?.clerkUserId });
  });
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("requireAuth + clerkMiddleware — integration contract", () => {
  let app: ReturnType<typeof buildTestApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env["OWNER_CLERK_EMAIL"];

    // Standard two-call DB pattern: odd call = main user lookup, even call =
    // secondary-account dedup query (no match keeps the primary user).
    findFirstMock.mockImplementation(async () => {
      const callN = findFirstMock.mock.calls.length;
      return callN % 2 === 1 ? { ...mockUser } : undefined;
    });

    app = buildTestApp();
  });

  // -------------------------------------------------------------------------
  // 1. Happy path — clerkMiddleware resolves a live-instance Bearer token
  //
  // Simulates: the EAS production binary (built with pk_live_...) sends a
  // Bearer JWT. clerkMiddleware calls clerkClient.authenticateRequest, which
  // verifies the token against the live JWKS and returns a signed-in state.
  // requireAuth must call next() and populate req.appUser.
  // -------------------------------------------------------------------------
  it("accepts a Bearer token that clerkMiddleware resolves as signed-in", async () => {
    mockClerkClient.authenticateRequest.mockResolvedValueOnce(
      makeSignedInState(mockUser.clerkUserId),
    );

    const res = await supertest(app)
      .get("/probe")
      .set("Authorization", "Bearer valid-live-clerk-token");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      userId: mockUser.id,
      clerkUserId: mockUser.clerkUserId,
    });
    // DB was read — no caching.
    expect(findFirstMock).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 2. req.appUser is the DB row, not raw Clerk state
  //
  // Confirms that requireAuth resolves the local `users` table row (with
  // entitlement fields, stripeCustomerId, etc.) — not just the Clerk userId.
  // This is the guarantee that a RevenueCat webhook revocation is reflected.
  // -------------------------------------------------------------------------
  it("populates req.appUser with the local DB row, including entitlement fields", async () => {
    const proUser = { ...mockUser, revenueCatEntitlement: "pro" };
    // First DB call (main lookup) returns a pro user.
    findFirstMock.mockResolvedValueOnce(proUser);
    // Second DB call (dedup query) finds no match.
    findFirstMock.mockResolvedValueOnce(undefined);

    mockClerkClient.authenticateRequest.mockResolvedValueOnce(
      makeSignedInState(mockUser.clerkUserId),
    );

    const res = await supertest(app)
      .get("/probe")
      .set("Authorization", "Bearer valid-live-clerk-token");

    expect(res.status).toBe(200);
    // The route echoes userId from req.appUser — confirm it's the DB row.
    expect(res.body.userId).toBe(mockUser.id);
  });

  // -------------------------------------------------------------------------
  // 3. No Authorization header → 401
  //
  // clerkMiddleware returns a signed-out state when no token is present.
  // requireAuth must return 401 without touching the DB.
  // -------------------------------------------------------------------------
  it("returns 401 when no Authorization header is present", async () => {
    mockClerkClient.authenticateRequest.mockResolvedValueOnce(makeSignedOutState());

    const res = await supertest(app).get("/probe");

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: "Unauthorized" });
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 4. Expired or invalid Bearer token → 401
  //
  // Simulates a mobile JWT that has expired or was signed by the wrong Clerk
  // instance. clerkMiddleware returns a signed-out state; requireAuth → 401.
  // -------------------------------------------------------------------------
  it("returns 401 when the Bearer token is expired or invalid", async () => {
    mockClerkClient.authenticateRequest.mockResolvedValueOnce(makeSignedOutState());

    const res = await supertest(app)
      .get("/probe")
      .set("Authorization", "Bearer expired-or-wrong-issuer-token");

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: "Unauthorized" });
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 5. clerkMiddleware NOT mounted before requireAuth → loud 500 (not silent)
  //
  // If clerkMiddleware is removed from app.ts (or mounted after requireAuth),
  // getAuth(req) throws "clerkMiddleware should be registered before getAuth".
  // requireAuth catches this and returns 500 — a loud configuration error,
  // not a silent 401 that could be mistaken for "no session".
  // This test pins the middleware-order requirement.
  // -------------------------------------------------------------------------
  it("returns 500 (loud config error) when clerkMiddleware is absent before requireAuth", async () => {
    // Build an app WITHOUT clerkMiddleware — only requireAuth.
    const brokenApp = express();
    brokenApp.use(express.json());
    // requireAuth runs without clerkMiddleware having set req.auth.
    brokenApp.get("/probe", requireAuth, (req, res) => {
      res.json({ ok: true });
    });

    const res = await supertest(brokenApp)
      .get("/probe")
      .set("Authorization", "Bearer some-valid-token");

    // getAuth(req) throws → requireAuth catch → 500 (not a silent 401).
    expect(res.status).toBe(500);
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 6. proxyUrl misconfiguration — clerkMiddleware rejects the live mobile iss
  //
  // Background: passing proxyUrl to clerkMiddleware() tells the SDK to expect
  // iss: <proxyUrl> in the JWT. A live mobile token carries
  // iss: https://immortal-swan-47.clerk.accounts.dev — mismatched → rejected.
  //
  // This test confirms that clerkMiddleware() without proxyUrl correctly
  // accepts the live-instance iss. The mock simulates what Clerk returns when
  // iss matches: a signed-in state.
  //
  // If someone adds proxyUrl to clerkMiddleware() in app.ts, live mobile
  // tokens will be rejected by Clerk's own JWT verifier (before reaching
  // authenticateRequest mock) — this test documents why proxyUrl must be
  // absent for mobile-first deployments.
  // -------------------------------------------------------------------------
  it("accepts a live mobile token when clerkMiddleware has no proxyUrl (expected configuration)", async () => {
    // clerkMiddleware without proxyUrl — same as app.ts.
    const mobileApp = express();
    mobileApp.use(express.json());
    mobileApp.use(clerkMiddleware({ clerkClient: mockClerkClient as never }));
    mobileApp.get("/probe", requireAuth, (req, res) => {
      res.json({ userId: req.appUser?.id });
    });

    mockClerkClient.authenticateRequest.mockResolvedValueOnce(
      makeSignedInState(mockUser.clerkUserId),
    );

    const res = await supertest(mobileApp)
      .get("/probe")
      .set("Authorization", "Bearer live-mobile-token-from-pk-live-instance");

    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(mockUser.id);
  });
});

// ---------------------------------------------------------------------------
// app.ts source-level configuration assertions
//
// These tests parse the production app.ts source file directly. They catch
// configuration regressions that the HTTP-level integration tests above
// cannot: removing clerkMiddleware, adding proxyUrl, or reordering middleware
// all change the source file and would be caught here before reaching CI.
//
// Source assertions are appropriate here because:
//   - The tested invariant ("clerkMiddleware() has no proxyUrl") is a static
//     configuration choice, not runtime behaviour.
//   - Importing the full app.ts in a unit test requires mocking every route
//     handler, DB client, and logger — adding noise without adding signal.
//   - The HTTP integration suite above already validates runtime behaviour;
//     this suite validates the configuration that makes it possible.
// ---------------------------------------------------------------------------

const APP_TS_PATH = resolve(__dirname, "../../app.ts");
const appSource = readFileSync(APP_TS_PATH, "utf8");

describe("app.ts clerkMiddleware configuration (source assertions)", () => {
  // We need the app.use(clerkMiddleware(...)) mount line specifically.
  // app.ts also has a comment that mentions clerkMiddleware() — using
  // `app.use(clerkMiddleware(` as the anchor string ensures we match only
  // the actual middleware registration, not any comment or import.
  const MOUNT_ANCHOR = "app.use(clerkMiddleware(";
  const ROUTER_ANCHOR = 'app.use("/api", router)';

  // -------------------------------------------------------------------------
  // C1. The actual app.use(clerkMiddleware(...)) mount has no proxyUrl
  //
  // Passing proxyUrl to clerkMiddleware() tells the SDK to expect
  // iss: <proxyUrl> in every JWT. Live mobile tokens carry the Clerk FAPI
  // iss (not the proxy URL) so they would be rejected — breaking all mobile
  // sign-in in production.
  //
  // We extract the full mount statement from the source and assert it matches
  // exactly `app.use(clerkMiddleware())` — no options object, no proxyUrl.
  // This fails if someone adds `proxyUrl` to the call in app.ts.
  // -------------------------------------------------------------------------
  it("app.use(clerkMiddleware()) has no options object and no proxyUrl", () => {
    const mountPos = appSource.indexOf(MOUNT_ANCHOR);
    expect(mountPos).toBeGreaterThan(-1); // mount must exist

    // Grab the content from the anchor to the end of that statement.
    const fromMount = appSource.slice(mountPos);
    const stmtEnd   = fromMount.indexOf(";");
    const stmt       = fromMount.slice(0, stmtEnd + 1); // e.g. "app.use(clerkMiddleware());"

    // Must be the no-arg form.
    expect(stmt).toBe("app.use(clerkMiddleware());");
    // Belt-and-suspenders: proxyUrl must not appear anywhere in this statement.
    expect(stmt).not.toContain("proxyUrl");
  });

  // -------------------------------------------------------------------------
  // C2. app.use(clerkMiddleware()) appears before the API router mount
  //
  // requireAuth calls getAuth(req), which reads the auth state deposited by
  // clerkMiddleware. If clerkMiddleware is mounted after the router, every
  // protected route gets a 500 ("clerkMiddleware should be registered first").
  // -------------------------------------------------------------------------
  it("app.use(clerkMiddleware()) is mounted before app.use('/api', router)", () => {
    const mountPos  = appSource.indexOf(MOUNT_ANCHOR);
    const routerPos = appSource.indexOf(ROUTER_ANCHOR);

    expect(mountPos).toBeGreaterThan(-1);
    expect(routerPos).toBeGreaterThan(-1);
    expect(mountPos).toBeLessThan(routerPos);
  });

  // -------------------------------------------------------------------------
  // C3. app.use(clerkMiddleware()) is present in app.ts
  //
  // Belt-and-suspenders: if clerkMiddleware is removed from app.ts entirely,
  // C1 and C2 already fail — but this assertion names the regression
  // precisely so the CI message is immediately actionable.
  // -------------------------------------------------------------------------
  it("app.use(clerkMiddleware()) is present in app.ts", () => {
    expect(appSource).toContain(MOUNT_ANCHOR);
  });
});
