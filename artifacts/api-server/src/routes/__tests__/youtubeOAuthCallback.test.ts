/**
 * YouTube OAuth callback — deep-link redirect contract
 *
 * Verifies that GET /api/auth/youtube/callback correctly redirects the coach
 * back to the mobile app via the hoopsstats:// deep-link scheme so that
 * expo-web-browser openAuthSessionAsync can detect the result and close the
 * in-app browser.
 *
 * The OAuth state is a stateless HMAC-signed token (signed with SESSION_SECRET)
 * so it survives server restarts. The token carries userId, returnTo, a jti
 * (unique per request), and a 10-minute expiry.
 *
 * Scenarios:
 *   1. Happy path: valid state token + Google returns a refresh token
 *      → 302 to hoopsstats://?youtube=connected
 *   2. No refresh token from Google (already granted access)
 *      → 302 to hoopsstats://?youtube=error
 *   3. Missing code or state query param → 400
 *   4. Tampered / unknown state token    → 400
 *   5. Expired state token (past 10-min TTL) → 400
 *   6. exchangeCode throws               → 302 to hoopsstats://?youtube=error
 *   7. returnTo is validated — an open-redirect URL falls back to "/"
 *
 * The server also issues the state token via POST /api/auth/youtube/connect-url
 * (exercised in test 8) so we confirm the returned URL carries a valid token
 * that the callback route will later recognise.
 */

// Set env vars before any imports so modules that read process.env at load
// time (youtubeClient, tokenEncryption) pick them up.
process.env.GOOGLE_CLIENT_ID = "test-client-id";
process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
// 64 hex chars = 32-byte AES-256 key (test-only value)
process.env.YOUTUBE_TOKEN_ENCRYPTION_KEY =
  "d42ea456470a54933710a122cc885cfff94995847c51167327a0c249c7fa0d95";
process.env.YOUTUBE_CALLBACK_URL =
  "https://example.com/api/auth/youtube/callback";

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import express, { type Request, type Response, type NextFunction } from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";

// ---------------------------------------------------------------------------
// Shared mock state (hoisted so vi.mock() factories can reference them)
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => {
  const dbUpdateWhere = vi.fn().mockResolvedValue(undefined);
  const dbUpdateSet = vi.fn().mockReturnValue({ where: dbUpdateWhere });
  const dbUpdate = vi.fn().mockReturnValue({ set: dbUpdateSet });

  const exchangeCode = vi.fn<() => Promise<{ refreshToken: string | null }>>();

  return { dbUpdate, dbUpdateSet, dbUpdateWhere, exchangeCode };
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("googleapis", () => ({
  google: {
    auth: {
      OAuth2: vi.fn().mockImplementation(function OAuth2() {
        return {
          setCredentials: vi.fn(),
          generateAuthUrl: vi.fn((params: Record<string, unknown>) => {
            // Embed the state/nonce in the URL so tests can extract it.
            const state = (params.state as string) ?? "test-nonce";
            return `https://accounts.google.com/o/oauth2/auth?state=${state}`;
          }),
          getToken: vi.fn(),
        };
      }),
    },
    youtube: vi.fn().mockReturnValue({
      videos: { insert: vi.fn() },
    }),
  },
}));

vi.mock("@workspace/db", () => ({
  db: {
    query: {
      gamesTable: { findFirst: vi.fn() },
      usersTable: { findFirst: vi.fn() },
    },
    update: mocks.dbUpdate,
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
  },
  usersTable: {},
  gamesTable: {},
  playerGameStatsTable: {},
  playersTable: {},
}));

vi.mock("../../middlewares/requireAuth", () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    (req as any).appUser = { id: 99, stripeCustomerId: null, email: "coach@test.com" };
    next();
  },
}));

vi.mock("../../lib/entitlements", () => ({
  getEntitlements: vi.fn().mockResolvedValue({ plan: "premium" }),
  getEntitlementsForUser: vi.fn().mockResolvedValue({ plan: "premium" }),
  isPro: vi.fn().mockReturnValue(true),
}));

vi.mock("../../lib/objectStorage", () => ({
  ObjectStorageService: vi.fn().mockImplementation(function ObjectStorageService() {
    return {
      getObjectEntityFile: vi.fn().mockResolvedValue({
        createReadStream: vi.fn().mockReturnValue({ pipe: vi.fn() }),
      }),
    };
  }),
}));

vi.mock("../../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Partially mock youtubeClient — override exchangeCode only so we control
// what Google "returns" without making real network calls.
vi.mock("../../lib/youtubeClient", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/youtubeClient")>();
  return {
    ...original,
    exchangeCode: mocks.exchangeCode,
    uploadToYoutube: vi.fn().mockResolvedValue("https://youtu.be/test"),
  };
});

// ---------------------------------------------------------------------------
// Real imports (after all mocks are registered)
// ---------------------------------------------------------------------------
import youtubeRouter from "../youtube";

// ---------------------------------------------------------------------------
// Test server setup
// ---------------------------------------------------------------------------
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", youtubeRouter);

  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/api`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.dbUpdate.mockReturnValue({ set: mocks.dbUpdateSet });
  mocks.dbUpdateSet.mockReturnValue({ where: mocks.dbUpdateWhere });
  mocks.dbUpdateWhere.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Helper: obtain a real nonce by calling the connect-url endpoint
// ---------------------------------------------------------------------------
async function getConnectUrl(returnTo = "hoopsstats://"): Promise<{ url: string; nonce: string }> {
  const res = await fetch(`${baseUrl}/auth/youtube/connect-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ returnTo }),
  });
  expect(res.ok).toBe(true);
  const { url } = (await res.json()) as { url: string };
  // The mocked generateAuthUrl embeds the nonce as the `state` query param.
  const nonce = new URL(url).searchParams.get("state") ?? "";
  expect(nonce).toBeTruthy();
  return { url, nonce };
}

// ---------------------------------------------------------------------------
// Suite — OAuth callback redirect contract
// ---------------------------------------------------------------------------
describe("GET /api/auth/youtube/callback — hoopsstats:// deep-link redirect", () => {

  // -------------------------------------------------------------------------
  // 1. Happy path: valid nonce + refresh token → youtube=connected
  // -------------------------------------------------------------------------
  it("redirects to hoopsstats://?youtube=connected on a successful token exchange", async () => {
    const { nonce } = await getConnectUrl("hoopsstats://");
    mocks.exchangeCode.mockResolvedValue({ refreshToken: "google-refresh-token-xyz" });

    const res = await fetch(
      `${baseUrl}/auth/youtube/callback?code=auth_code&state=${nonce}`,
      { redirect: "manual" },
    );

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";

    // The browser (expo-web-browser) detects this and closes the sheet.
    expect(location).toContain("youtube=connected");
    expect(location.startsWith("hoopsstats://")).toBe(true);

    // DB must have been updated with the (encrypted) refresh token.
    expect(mocks.dbUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.dbUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ youtubeRefreshToken: expect.any(String) }),
    );
  });

  // -------------------------------------------------------------------------
  // 2. No refresh token from Google → youtube=error
  // -------------------------------------------------------------------------
  it("redirects to hoopsstats://?youtube=error when Google omits the refresh token", async () => {
    const { nonce } = await getConnectUrl("hoopsstats://");
    // Google only issues a refresh token on first consent; subsequent re-auths
    // omit it.  The server must not silently succeed.
    mocks.exchangeCode.mockResolvedValue({ refreshToken: null });

    const res = await fetch(
      `${baseUrl}/auth/youtube/callback?code=auth_code&state=${nonce}`,
      { redirect: "manual" },
    );

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("youtube=error");
    expect(location.startsWith("hoopsstats://")).toBe(true);

    // DB must NOT be updated — the token is absent, so there is nothing to store.
    expect(mocks.dbUpdate).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 3. exchangeCode throws → youtube=error (server error during exchange)
  // -------------------------------------------------------------------------
  it("redirects to hoopsstats://?youtube=error when exchangeCode throws", async () => {
    const { nonce } = await getConnectUrl("hoopsstats://");
    mocks.exchangeCode.mockRejectedValue(new Error("Google token endpoint returned 500"));

    const res = await fetch(
      `${baseUrl}/auth/youtube/callback?code=auth_code&state=${nonce}`,
      { redirect: "manual" },
    );

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("youtube=error");
    expect(location.startsWith("hoopsstats://")).toBe(true);

    expect(mocks.dbUpdate).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 4. Missing code → 400 (malformed Google callback)
  // -------------------------------------------------------------------------
  it("returns 400 when the code query parameter is missing", async () => {
    const { nonce } = await getConnectUrl("hoopsstats://");
    mocks.exchangeCode.mockResolvedValue({ refreshToken: "token" });

    const res = await fetch(
      `${baseUrl}/auth/youtube/callback?state=${nonce}`,
      { redirect: "manual" },
    );

    expect(res.status).toBe(400);
    expect(mocks.exchangeCode).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 5. Missing state → 400
  // -------------------------------------------------------------------------
  it("returns 400 when the state query parameter is missing", async () => {
    const res = await fetch(
      `${baseUrl}/auth/youtube/callback?code=auth_code`,
      { redirect: "manual" },
    );

    expect(res.status).toBe(400);
    expect(mocks.exchangeCode).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 6. Unknown nonce → 400 (CSRF / replay guard)
  // -------------------------------------------------------------------------
  it("returns 400 when the state nonce is not in the server map (CSRF guard)", async () => {
    const res = await fetch(
      `${baseUrl}/auth/youtube/callback?code=auth_code&state=totally-unknown-nonce`,
      { redirect: "manual" },
    );

    expect(res.status).toBe(400);
    expect(mocks.exchangeCode).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 7. Expired state token → 400
  //    The HMAC token embeds an `exp` timestamp (Date.now() + 10 min).
  //    We advance fake timers past the TTL so verifyOAuthState rejects it.
  // -------------------------------------------------------------------------
  it("returns 400 when the state token has passed its 10-minute TTL", async () => {
    // Obtain a real token while time is "normal".
    const { nonce } = await getConnectUrl("hoopsstats://");
    mocks.exchangeCode.mockResolvedValue({ refreshToken: "token" });

    // Advance time by 11 minutes so the embedded exp is in the past.
    vi.useFakeTimers();
    vi.advanceTimersByTime(11 * 60 * 1000);

    try {
      const res = await fetch(
        `${baseUrl}/auth/youtube/callback?code=auth_code&state=${nonce}`,
        { redirect: "manual" },
      );
      expect(res.status).toBe(400);
      expect(mocks.exchangeCode).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // -------------------------------------------------------------------------
  // 8. connect-url endpoint: returnTo is included in state and propagated
  //    through the redirect so the mobile deep-link scheme is used
  // -------------------------------------------------------------------------
  it("POST /auth/youtube/connect-url returns a Google OAuth URL that can be opened in-app", async () => {
    const res = await fetch(`${baseUrl}/auth/youtube/connect-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ returnTo: "hoopsstats://" }),
    });

    expect(res.ok).toBe(true);
    const body = (await res.json()) as { url?: string };

    // The returned URL must be a Google OAuth URL (or our mocked equivalent).
    expect(body.url).toBeTruthy();
    expect(typeof body.url).toBe("string");
    // The URL must contain a state param (the nonce).
    const parsed = new URL(body.url as string);
    expect(parsed.searchParams.get("state")).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // 9. validateReturnTo: open-redirect via absolute URL is rejected
  // -------------------------------------------------------------------------
  it("falls back to / for returnTo when the caller supplies an absolute external URL", async () => {
    // Obtain a nonce with a malicious returnTo — the server should normalise it.
    const res = await fetch(`${baseUrl}/auth/youtube/connect-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ returnTo: "https://evil.example.com/steal" }),
    });
    expect(res.ok).toBe(true);
    const { url } = (await res.json()) as { url: string };
    const nonce = new URL(url).searchParams.get("state") ?? "";

    mocks.exchangeCode.mockResolvedValue({ refreshToken: "token-ok" });

    const callbackRes = await fetch(
      `${baseUrl}/auth/youtube/callback?code=auth_code&state=${nonce}`,
      { redirect: "manual" },
    );

    expect(callbackRes.status).toBe(302);
    const location = callbackRes.headers.get("location") ?? "";

    // Must redirect to /?youtube=connected — not to evil.example.com.
    expect(location.startsWith("https://evil.example.com")).toBe(false);
    expect(location).toContain("youtube=connected");
  });
});
