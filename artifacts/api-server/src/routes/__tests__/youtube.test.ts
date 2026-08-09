/**
 * YouTube upload — token-expiry reconnect flow
 *
 * This file covers two distinct surfaces:
 *
 * 1. youtubeClient unit test: verifies that a 401/403 error thrown by
 *    googleapis is converted into a YouTubeAuthError (so the route can
 *    distinguish it from network errors and clear the stale token).
 *
 * 2. Route integration test: mounts the real express youtube router with all
 *    external dependencies mocked and exercises the full HTTP request→response
 *    path, verifying:
 *    - a YouTubeAuthError clears DB youtubeRefreshToken + returns 403
 *      YOUTUBE_NOT_CONNECTED (which the frontend converts into a redirect to
 *      /api/auth/youtube/connect — see record.tsx handleConfirmYoutubeUpload)
 *    - a non-auth error does NOT clear the token
 *    - missing token short-circuits before calling googleapis
 *    - a successful upload returns the YouTube URL and never touches the token
 */

// Set env vars before any module is imported so modules reading process.env
// at load time (tokenEncryption, youtubeClient) pick them up.
process.env.GOOGLE_CLIENT_ID = "test-client-id";
process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
// 64-hex chars = 32-byte AES-256 key (test-only)
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
// Shared mock state — vi.hoisted() so references are available inside
// vi.mock() factories (which are hoisted before regular imports).
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => {
  const dbUpdateWhere = vi.fn().mockResolvedValue(undefined);
  const dbUpdateSet = vi.fn().mockReturnValue({ where: dbUpdateWhere });
  const dbUpdate = vi.fn().mockReturnValue({ set: dbUpdateSet });

  const findFirstGame = vi.fn();
  const findFirstUser = vi.fn();
  const selectPlayerStats = vi.fn().mockResolvedValue([]);

  // Controls what uploadToYoutube does in integration tests.
  const uploadToYoutubeImpl = vi.fn<() => Promise<string>>();

  // Controls what googleapis videos.insert does in youtubeClient unit tests.
  const videosInsert = vi.fn<() => Promise<unknown>>();

  return {
    dbUpdate,
    dbUpdateSet,
    dbUpdateWhere,
    findFirstGame,
    findFirstUser,
    selectPlayerStats,
    uploadToYoutubeImpl,
    videosInsert,
  };
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
          generateAuthUrl: vi.fn(() => "https://accounts.google.com/o/oauth2/auth"),
          getToken: vi.fn(),
        };
      }),
    },
    youtube: vi.fn().mockReturnValue({
      videos: { insert: mocks.videosInsert },
    }),
  },
}));

vi.mock("@workspace/db", () => ({
  db: {
    query: {
      gamesTable: { findFirst: mocks.findFirstGame },
      usersTable: { findFirst: mocks.findFirstUser },
    },
    update: mocks.dbUpdate,
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: mocks.selectPlayerStats,
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
    (req as any).appUser = {
      id: 42,
      stripeCustomerId: null,
      email: "coach@test.com",
    };
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

// Mock youtubeClient so we control what uploadToYoutube throws/returns.
// The unit tests below separately verify that googleapis 401/403 → YouTubeAuthError.
vi.mock("../../lib/youtubeClient", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/youtubeClient")>();
  return {
    ...original,
    uploadToYoutube: mocks.uploadToYoutubeImpl,
  };
});

// ---------------------------------------------------------------------------
// Real imports (after all mocks are registered)
// ---------------------------------------------------------------------------
import { encryptToken } from "../../lib/tokenEncryption";
import { YouTubeAuthError } from "../../lib/youtubeClient";
import youtubeRouter from "../youtube";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const GAME_ID = 7;

function makeMockGame(overrides?: object) {
  return {
    id: GAME_ID,
    ownerId: 42,
    highlightStatus: "ready",
    highlightObjectPath: "highlights/game-7.mp4",
    result: "W",
    opponent: "Rivals",
    teamScore: 80,
    opponentScore: 70,
    date: "2026-01-10T00:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite 1 — youtubeClient unit: googleapis 401/403 → YouTubeAuthError
//
// The googleapis module is mocked at file level with a vi.fn() insert stub
// (mocks.videosInsert). These tests drive that stub to simulate what Google's
// API returns when a refresh token is revoked, and verify that the client
// layer converts it into a YouTubeAuthError that the route can recognise.
// ---------------------------------------------------------------------------
describe("youtubeClient — googleapis error mapping", () => {
  // The real uploadToYoutube (imported via importActual, bypassing the partial
  // mock we apply to youtubeClient for the integration tests).
  let realUpload: typeof import("../../lib/youtubeClient").uploadToYoutube;
  let Readable: typeof import("stream").Readable;

  beforeAll(async () => {
    const mod = await vi.importActual<typeof import("../../lib/youtubeClient")>(
      "../../lib/youtubeClient",
    );
    realUpload = mod.uploadToYoutube;
    ({ Readable } = await import("stream"));
  });

  function makeStream() {
    return new Readable({ read() { this.push(null); } });
  }

  const uploadArgs = () => ({
    refreshToken: "fake-token",
    title: "Test",
    description: "Test",
    privacyStatus: "unlisted" as const,
    stream: makeStream(),
  });

  it("converts a googleapis 401 status into YouTubeAuthError", async () => {
    mocks.videosInsert.mockRejectedValue(
      Object.assign(new Error("Token expired"), { status: 401 }),
    );
    await expect(realUpload(uploadArgs())).rejects.toThrow(YouTubeAuthError);
  });

  it("converts a googleapis 403 status into YouTubeAuthError", async () => {
    mocks.videosInsert.mockRejectedValue(
      Object.assign(new Error("Forbidden"), { status: 403 }),
    );
    await expect(realUpload(uploadArgs())).rejects.toThrow(YouTubeAuthError);
  });

  it("re-throws non-auth googleapis errors without wrapping them", async () => {
    mocks.videosInsert.mockRejectedValue(new Error("Network timeout"));
    const err = await realUpload(uploadArgs()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(YouTubeAuthError);
    expect((err as Error).message).toBe("Network timeout");
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — Route integration: token-expiry → YOUTUBE_NOT_CONNECTED + DB clear
// ---------------------------------------------------------------------------
describe("YouTube upload route — token-expiry reconnect flow", () => {
  let server: Server;
  let baseUrl: string;
  let encryptedToken: string;

  beforeAll(async () => {
    encryptedToken = encryptToken("fake-google-refresh-token");

    const app = express();
    app.use(express.json());
    app.use("/api", youtubeRouter);

    server = createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}/api`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    vi.clearAllMocks();

    // Re-apply stubs that clearAllMocks would otherwise clear.
    mocks.dbUpdate.mockReturnValue({ set: mocks.dbUpdateSet });
    mocks.dbUpdateSet.mockReturnValue({ where: mocks.dbUpdateWhere });
    mocks.dbUpdateWhere.mockResolvedValue(undefined);
    mocks.selectPlayerStats.mockResolvedValue([]);
  });

  async function post(body: object) {
    return fetch(`${baseUrl}/games/${GAME_ID}/highlight/upload-youtube`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  // -------------------------------------------------------------------------
  // Test 1: expired token (simulated by YouTubeAuthError) → DB cleared + 403
  // -------------------------------------------------------------------------
  it("clears the DB token and returns YOUTUBE_NOT_CONNECTED when the token is expired (401)", async () => {
    mocks.findFirstGame.mockResolvedValue(makeMockGame());
    mocks.findFirstUser.mockResolvedValue({
      id: 42,
      youtubeRefreshToken: encryptedToken,
    });
    // Simulate what googleapis returns when refresh token is revoked (401).
    mocks.uploadToYoutubeImpl.mockRejectedValue(
      new YouTubeAuthError("YouTube token expired or revoked — please reconnect"),
    );

    const res = await post({ title: "Test Upload", privacyStatus: "unlisted" });

    // The frontend (record.tsx handleConfirmYoutubeUpload) reads this error
    // code and redirects to /api/auth/youtube/connect.
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("YOUTUBE_NOT_CONNECTED");

    // DB must be updated to clear the stale token so the coach is prompted
    // to reconnect instead of silently failing on every subsequent upload.
    expect(mocks.dbUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.dbUpdateSet).toHaveBeenCalledWith({ youtubeRefreshToken: null });
  });

  // -------------------------------------------------------------------------
  // Test 2: non-auth error does NOT clear the token (preserve connectivity)
  // -------------------------------------------------------------------------
  it("does NOT clear the DB token on a transient (non-auth) googleapis error", async () => {
    mocks.findFirstGame.mockResolvedValue(makeMockGame());
    mocks.findFirstUser.mockResolvedValue({
      id: 42,
      youtubeRefreshToken: encryptedToken,
    });
    mocks.uploadToYoutubeImpl.mockRejectedValue(new Error("Network timeout"));

    const res = await post({ title: "Test Upload", privacyStatus: "unlisted" });

    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    // Must NOT be the reconnect error code — coach should not be logged out.
    expect(body.error).not.toBe("YOUTUBE_NOT_CONNECTED");

    // Token must be preserved — a transient failure should not disconnect.
    expect(mocks.dbUpdate).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 3: no token stored → YOUTUBE_NOT_CONNECTED without calling googleapis
  // -------------------------------------------------------------------------
  it("returns YOUTUBE_NOT_CONNECTED immediately when no token is stored in DB", async () => {
    mocks.findFirstGame.mockResolvedValue(makeMockGame());
    mocks.findFirstUser.mockResolvedValue({
      id: 42,
      youtubeRefreshToken: null,
    });

    const res = await post({ title: "Test Upload", privacyStatus: "unlisted" });

    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("YOUTUBE_NOT_CONNECTED");

    // uploadToYoutube must never be called — we short-circuit before it.
    expect(mocks.uploadToYoutubeImpl).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 4: successful upload — returns YouTube URL, persists it to the game
  //         row, but never touches the refresh token
  // -------------------------------------------------------------------------
  it("returns a YouTube URL on success, persists it to the game row, and never touches the refresh token", async () => {
    mocks.findFirstGame.mockResolvedValue(makeMockGame());
    mocks.findFirstUser.mockResolvedValue({
      id: 42,
      youtubeRefreshToken: encryptedToken,
    });
    mocks.uploadToYoutubeImpl.mockResolvedValue("https://youtu.be/abc123Video");

    const res = await post({ title: "Test Upload", privacyStatus: "unlisted" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.youtubeUrl).toBe("https://youtu.be/abc123Video");

    // The route must persist the YouTube URL to the game row so the mobile
    // app can re-surface the link after remounting.
    expect(mocks.dbUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.dbUpdateSet).toHaveBeenCalledWith({
      highlightYoutubeUrl: "https://youtu.be/abc123Video",
    });

    // The refresh token must NOT be cleared on a successful upload — only
    // auth failures should clear it.
    const setArg = mocks.dbUpdateSet.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArg).not.toHaveProperty("youtubeRefreshToken");
  });
});
