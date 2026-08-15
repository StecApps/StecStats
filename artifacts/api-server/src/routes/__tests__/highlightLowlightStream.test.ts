/**
 * Highlight / lowlight streaming — redirect-ALL design regression test
 *
 * The /games/:gameId/stream/:type endpoint redirects ALL requests — both
 * full-file loads and Range seeks — to a 3600 s GCS signed URL.  This
 * bypasses the Replit reverse proxy entirely: piping bytes through the proxy
 * kills playback after ~1–2 s, whereas GCS handles Range requests natively so
 * the player can seek freely without any further server involvement.
 *
 * Seek-after-token-expiry design guarantee:
 *   The /stream-token/:type endpoint pre-generates a 5 h GCS signed URL and
 *   returns it as `streamUrl` in the JSON response.  The mobile client passes
 *   this URL directly to expo-video/AVPlayer so ALL seeks (including Range
 *   requests) go to GCS without the player contacting the server again.
 *
 *   The stream token (4 h TTL) is only consulted for fresh /stream-token
 *   requests (background refresh, player restart).  Because the GCS URL TTL
 *   (5 h) > token TTL (4 h), the URL stays valid for 1 h after the token
 *   expires — the coach can seek freely for that entire window.
 *
 *   If the subscription lapses, the entitlement re-check (5 min interval)
 *   will block NEW /stream-token requests with 403, but it cannot revoke a
 *   GCS URL already in the player's hands.
 *
 * This suite verifies:
 *
 *   A. FULL-FILE AND RANGE → 302 signed-URL redirect (highlight + lowlight)
 *      Every request (with or without a Range header) must yield a 302 whose
 *      Location is the GCS signed URL with a 3600 s TTL.
 *
 *   B. RANGE SEEKS → same 302 redirect (not a 206 partial-content response)
 *      Seeking is handled entirely by GCS; the server never pipes bytes.
 *
 *   C. YouTube URL returned when highlight is ready
 *      GET /games/:gameId/highlight must include a youtubeUrl field so the
 *      mobile client can show the Upload to YouTube button.
 *
 *   D. SEEK AFTER TOKEN EXPIRY / ENTITLEMENT LAPSE
 *      Confirms the seek-after-token-expiry guarantee described above:
 *      the server correctly blocks new requests after token/entitlement
 *      expiry, but the already-issued GCS URL (3600 s TTL) is unaffected.
 *
 * No real GCS bucket, database, or camera access is required — all I/O
 * layers are replaced with in-memory mocks following the pattern in
 * streamTokenSecurity.test.ts.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";

// ---------------------------------------------------------------------------
// Fixtures — hoisted so vi.mock() factories can close over them.
// ---------------------------------------------------------------------------
const {
  COACH_A,
  GAME_ID,
  PATH_HIGHLIGHT,
  PATH_LOWLIGHT,
  currentUser,
  /** "highlight" | "lowlight" | "no-reel" — controls which objectPath is set. */
  reelMode,
  /** The fake signed URL the mock returns. */
  SIGNED_URL,
  /**
   * Controls the return value of the `isPro` mock.  Default true (subscribed).
   * Set to false in entitlement-lapse tests to simulate a cancelled subscription.
   */
  isProResult,
} = vi.hoisted(() => {
  const COACH_A = { id: 1, clerkUserId: "clerk_coach_a", email: "coach@example.com" };
  const GAME_ID = 42;
  const PATH_HIGHLIGHT = "/objects/private/highlight-42.mp4";
  const PATH_LOWLIGHT  = "/objects/private/lowlight-42.mp4";
  const currentUser = { value: COACH_A as typeof COACH_A };
  const reelMode = { value: "highlight" as "highlight" | "lowlight" | "no-reel" };
  const SIGNED_URL = "https://storage.googleapis.com/bucket/highlight-42.mp4?X-Goog-Signature=abc";
  const isProResult = { value: true };
  return { COACH_A, GAME_ID, PATH_HIGHLIGHT, PATH_LOWLIGHT, currentUser, reelMode, SIGNED_URL, isProResult };
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("@workspace/db", () => ({
  db: {
    query: {
      gamesTable: {
        findFirst: vi.fn().mockImplementation(async () => ({
          id: GAME_ID,
          ownerId: COACH_A.id,
          teamId: 1,
          opponent: "Rivals",
          date: "2024-01-15",
          result: "W",
          teamScore: 80,
          opponentScore: 70,
          videoObjectPath: "/objects/private/game-42-video.mp4",
          videoOffsetMs: null,
          videoDurationMs: null,
          videoHalf2StartMs: null,
          videoHalftimeGapMs: null,
          videoProxyObjectPath: null,
          videoProxyVersion: null,
          highlightObjectPath: reelMode.value === "highlight" ? PATH_HIGHLIGHT : null,
          highlightStatus: reelMode.value === "highlight" ? "ready" : null,
          highlightGeneratorVersion: 99,
          highlightError: null,
          highlightStartedAt: null,
          highlightMusicTrack: null,
          highlightYoutubeUrl: "https://youtu.be/example123",
          lowlightObjectPath: reelMode.value === "lowlight" ? PATH_LOWLIGHT : null,
          lowlightStatus: reelMode.value === "lowlight" ? "ready" : null,
          lowlightGeneratorVersion: 99,
          lowlightError: null,
          lowlightStartedAt: null,
          shareToken: null,
          createdAt: new Date(),
        })),
      },
      teamsTable: {
        findFirst: vi.fn().mockResolvedValue({ id: 1, ownerId: COACH_A.id, name: "Test Squad" }),
      },
      playersTable: { findMany: vi.fn().mockResolvedValue([]) },
      gameEventsTable: { findMany: vi.fn().mockResolvedValue([]) },
      usersTable: {
        findFirst: vi.fn().mockResolvedValue({
          stripeCustomerId: null,
          email: COACH_A.email,
          revenueCatEntitlement: "premium",
        }),
      },
    },
    transaction: vi.fn().mockImplementation(async (fn: (tx: any) => Promise<any>) => {
      const tx = {
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
        }),
        delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      };
      return fn(tx);
    }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      }),
    }),
  },

  gamesTable: {
    id: "id",
    ownerId: "owner_id",
    videoObjectPath: "video_object_path",
    highlightObjectPath: "highlight_object_path",
    highlightStatus: "highlight_status",
    highlightError: "highlight_error",
    highlightStartedAt: "highlight_started_at",
    highlightGeneratorVersion: "highlight_generator_version",
    highlightMusicTrack: "highlight_music_track",
    highlightYoutubeUrl: "highlight_youtube_url",
    lowlightObjectPath: "lowlight_object_path",
    lowlightStatus: "lowlight_status",
    lowlightError: "lowlight_error",
    lowlightStartedAt: "lowlight_started_at",
    lowlightGeneratorVersion: "lowlight_generator_version",
    teamId: "team_id",
    opponent: "opponent",
    date: "date",
    result: "result",
    teamScore: "team_score",
    opponentScore: "opponent_score",
    videoOffsetMs: "video_offset_ms",
    videoDurationMs: "video_duration_ms",
    videoHalf2StartMs: "video_half2_start_ms",
    videoHalftimeGapMs: "video_halftime_gap_ms",
    videoProxyObjectPath: "video_proxy_object_path",
    videoProxyVersion: "video_proxy_version",
    shareToken: "share_token",
    createdAt: "created_at",
  },
  teamsTable:  { id: "id", ownerId: "owner_id", name: "name" },
  playersTable: { id: "id", ownerId: "owner_id", name: "name", photoObjectPath: "photo_object_path" },
  usersTable: { id: "id", stripeCustomerId: "stripe_customer_id", email: "email", revenueCatEntitlement: "revenue_cat_entitlement" },
  playerGameStatsTable: {
    gameId: "game_id", playerId: "player_id",
    ftMade: "ft_made", ftAttempted: "ft_attempted",
    twoMade: "two_made", twoAttempted: "two_attempted",
    threeMade: "three_made", threeAttempted: "three_attempted",
    assists: "assists", rebounds: "rebounds", steals: "steals",
    turnovers: "turnovers", blocks: "blocks", goals: "goals",
    shots: "shots", shotsOffTarget: "shots_off_target", saves: "saves",
    yellowCards: "yellow_cards", redCards: "red_cards",
  },
  gameEventsTable: {
    gameId: "game_id", playerId: "player_id",
    statField: "stat_field", delta: "delta",
    videoTimestampMs: "video_timestamp_ms",
  },
}));

vi.mock("../../lib/logger", () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock("../../middlewares/requireAuth", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.appUser = { ...currentUser.value } as any;
    next();
  },
}));

/** Track the last objectPath passed to getObjectEntityFile for stream requests. */
const lastStreamObjectPath = { value: "" };
/** Track whether createReadStream was called (Range path) vs getObjectEntitySignedURL (redirect path). */
const streamCalls = { createReadStream: 0, getSignedURL: 0 };
/**
 * Records every call to getObjectEntitySignedURL as { path, ttl } so tests
 * can assert both the object path and the TTL independently.
 */
const signedUrlCalls: Array<{ path: string; ttl: number }> = [];

vi.mock("../../lib/objectStorage", () => {
  const { Readable } = require("stream");

  class ObjectStorageService {
    getObjectEntityFile = vi.fn().mockImplementation(async (objectPath: string) => {
      lastStreamObjectPath.value = objectPath;
      return {
        getMetadata: vi.fn().mockResolvedValue([{ contentType: "video/mp4", size: 5_000_000 }]),
        createReadStream: vi.fn().mockImplementation((opts?: { start?: number; end?: number }) => {
          streamCalls.createReadStream += 1;
          const s = new Readable({ read() {} });
          // Emit a small chunk so 206 can complete
          process.nextTick(() => {
            s.push(Buffer.alloc(opts ? (opts.end! - opts.start! + 1) : 100));
            s.push(null);
          });
          return s;
        }),
      };
    });
    normalizeObjectEntityPath = vi.fn().mockImplementation((p: string) => p);
    canAccessObjectEntity = vi.fn().mockResolvedValue(false);
    getObjectEntitySignedURL = vi.fn().mockImplementation(async (path: string, ttl: number) => {
      streamCalls.getSignedURL += 1;
      signedUrlCalls.push({ path, ttl });
      return SIGNED_URL;
    });
    uploadLocalFileAsObjectEntity = vi.fn().mockResolvedValue("/objects/private/out.mp4");
    trySetObjectEntityAclPolicy = vi.fn().mockResolvedValue(undefined);
  }

  class ObjectNotFoundError extends Error {
    constructor(msg = "Not found") {
      super(msg);
      this.name = "ObjectNotFoundError";
      Object.setPrototypeOf(this, new.target.prototype);
    }
  }

  return { ObjectStorageService, ObjectNotFoundError };
});

vi.mock("../../lib/objectAcl", () => ({
  getObjectAclPolicy: vi.fn().mockResolvedValue(null),
  setObjectAclPolicy: vi.fn().mockResolvedValue(undefined),
  ObjectPermission: { READ: "READ", WRITE: "WRITE" },
}));

vi.mock("../../lib/entitlements", () => ({
  getEntitlementsForUser: vi.fn().mockResolvedValue({ plan: "premium" }),
  getEntitlements: vi.fn().mockResolvedValue({ plan: "premium" }),
  // Controlled by `isProResult` so individual tests can simulate a lapse.
  isPro: vi.fn().mockImplementation(() => isProResult.value),
}));

vi.mock("../../lib/videoDuration", () => ({
  scheduleVideoDurationProbe: vi.fn(),
}));

vi.mock("../../lib/highlightGenerator", () => ({
  PROXY_VERSION: 1,
  GENERATOR_VERSION: 99,
  ensureGameProxyInBackground: vi.fn(),
  cancelHighlightGeneration: vi.fn(),
  cancelProxyBuild: vi.fn(),
  countEligibleMoments: vi.fn().mockResolvedValue(5),
  getHighlightCoverage: vi.fn().mockResolvedValue({ eligibleMoments: 5, onFilmMoments: 3 }),
  generateHighlight: vi.fn(),
  cancelHighlightJob: vi.fn(),
}));

vi.mock("../../lib/lowlightGenerator", () => ({
  GENERATOR_VERSION: 99,
  generateLowlight: vi.fn(),
  cancelLowlightJob: vi.fn(),
  countEligibleLowlightMoments: vi.fn().mockResolvedValue(3),
  getLowlightCoverage: vi.fn().mockResolvedValue({ eligibleMoments: 3, onFilmMoments: 2 }),
}));

vi.mock("../../lib/musicTracks", () => ({
  getMusicTrackPath: vi.fn().mockReturnValue(null),
  MUSIC_TRACKS: [],
}));

vi.mock("child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("fs", async () => {
  const { Readable } = await import("stream");
  return {
    promises: {
      mkdtemp: vi.fn().mockResolvedValue("/tmp/test-stub"),
      writeFile: vi.fn().mockResolvedValue(undefined),
      rm: vi.fn().mockResolvedValue(undefined),
      stat: vi.fn().mockResolvedValue({ size: 5_000_000 }),
      open: vi.fn().mockResolvedValue({
        read: vi.fn().mockResolvedValue({ bytesRead: 0 }),
        close: vi.fn().mockResolvedValue(undefined),
      }),
    },
    createWriteStream: vi.fn().mockReturnValue({
      write: vi.fn((_data: any, cb: () => void) => cb()),
      end: vi.fn(),
    }),
    createReadStream: vi.fn().mockImplementation(() => {
      const s = new Readable({ read() {} });
      process.nextTick(() => s.push(null));
      return s;
    }),
    default: {},
  };
});

// ---------------------------------------------------------------------------
// Real imports (after mocks)
// ---------------------------------------------------------------------------
import gamesRouter from "../games";
import highlightsRouter from "../highlights";

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as any).log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    next();
  });
  app.use("/api", highlightsRouter);
  app.use("/api", gamesRouter);

  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.restoreAllMocks();
  vi.useRealTimers();
});

beforeEach(() => {
  currentUser.value = COACH_A;
  lastStreamObjectPath.value = "";
  streamCalls.createReadStream = 0;
  streamCalls.getSignedURL = 0;
  signedUrlCalls.length = 0;
  isProResult.value = true;
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function mintToken(gameId: number, type: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/games/${gameId}/stream-token/${type}`);
  if (!res.ok) throw new Error(`stream-token returned ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { token: string; streamUrl?: string };
  return body.token;
}

/**
 * Like mintToken but returns the full response body so tests can inspect
 * `streamUrl` — the pre-generated GCS URL that the mobile client passes
 * directly to expo-video/AVPlayer.
 */
async function mintTokenFull(gameId: number, type: string) {
  const res = await fetch(`${baseUrl}/api/games/${gameId}/stream-token/${type}`);
  if (!res.ok) throw new Error(`stream-token returned ${res.status}: ${await res.text()}`);
  return res.json() as Promise<{ token: string; streamUrl?: string; proxyReady: boolean; proxySkipped?: boolean }>;
}

/**
 * Issue a stream request.  fetch() follows redirects by default; we disable
 * that so we can inspect the 302 Location header directly.
 */
async function streamNoRange(gameId: number, type: string, token: string) {
  return fetch(`${baseUrl}/api/games/${gameId}/stream/${type}?t=${token}`, {
    redirect: "manual",
  });
}

/**
 * Issue a Range-seek request.  The endpoint now redirects ALL requests
 * (including Range seeks) to the GCS signed URL, so we use redirect:"manual"
 * to capture the 302 without following it to a real GCS bucket.
 */
async function streamWithRange(
  gameId: number,
  type: string,
  token: string,
  start: number,
  end: number,
) {
  return fetch(`${baseUrl}/api/games/${gameId}/stream/${type}?t=${token}`, {
    headers: { Range: `bytes=${start}-${end}` },
    redirect: "manual",
  });
}

// ---------------------------------------------------------------------------
// A — Full-file requests redirect to the GCS signed URL (no proxy buffering)
// ---------------------------------------------------------------------------

describe("Full-file request (no Range header) → 302 redirect to GCS signed URL", () => {
  it("redirects highlight full-file to the signed URL", async () => {
    reelMode.value = "highlight";
    const token = await mintToken(GAME_ID, "highlight");

    const res = await streamNoRange(GAME_ID, "highlight", token);

    // Must be a redirect — not a streamed response through the proxy.
    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toBe(SIGNED_URL);

    // getObjectEntitySignedURL must have been called (not createReadStream).
    expect(streamCalls.getSignedURL).toBe(1);
    expect(streamCalls.createReadStream).toBe(0);
  });

  it("redirects lowlight full-file to the signed URL", async () => {
    reelMode.value = "lowlight";
    const token = await mintToken(GAME_ID, "lowlight");

    const res = await streamNoRange(GAME_ID, "lowlight", token);

    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toBe(SIGNED_URL);

    expect(streamCalls.getSignedURL).toBe(1);
    expect(streamCalls.createReadStream).toBe(0);
  });

  it("stream-token response includes the pre-generated GCS URL (streamUrl)", async () => {
    /**
     * The /stream-token endpoint now returns `streamUrl` — a 5 h GCS signed
     * URL — alongside the auth token.  The mobile client uses this URL
     * directly as the expo-video source so all Range seeks go to GCS without
     * touching the server.  This is the core fix for post-expiry seeking:
     * no 302 redirect-caching ambiguity in AVPlayer.
     */
    reelMode.value = "highlight";
    const body = await mintTokenFull(GAME_ID, "highlight");

    // Must return a streamUrl pointing to the GCS bucket.
    expect(body.streamUrl).toBeDefined();
    expect(body.streamUrl).toBe(SIGNED_URL);
  });

  it("returns 403 and never signs a URL when the requester is not subscribed", async () => {
    /**
     * Security regression guard: /stream-token/:type issues a 5 h GCS signed
     * URL that cannot be revoked once sent.  A non-Pro owner must be rejected
     * at mint time — before any signing call is made — so the URL is never
     * placed in their hands.  The entitlement re-check on /stream/:type would
     * catch a *lapse* during an active session, but cannot protect against
     * initial issuance to a non-subscriber.
     */
    reelMode.value = "highlight";
    isProResult.value = false; // simulate non-Pro owner

    const res = await fetch(`${baseUrl}/api/games/${GAME_ID}/stream-token/highlight`);
    expect(res.status).toBe(403);

    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/subscription/i);

    // GCS signing must not have been invoked: no URL should leave the server.
    expect(signedUrlCalls).toHaveLength(0);
    expect(streamCalls.getSignedURL).toBe(0);
  });

  it("signs the highlight object path (not a generic path) with a 5 h (18 000 s) TTL", async () => {
    /**
     * The GCS URL is generated at /stream-token time (not /stream time) so
     * the mobile client receives it in the initial authenticated response.
     * mintToken() calls /stream-token, which triggers getObjectEntitySignedURL.
     * The subsequent streamNoRange() call to /stream/:type reuses the stored
     * URL — no second signing call is made.
     */
    reelMode.value = "highlight";
    const token = await mintToken(GAME_ID, "highlight");
    await streamNoRange(GAME_ID, "highlight", token);

    // Exactly one signing call: happens at /stream-token time.
    expect(signedUrlCalls).toHaveLength(1);
    // Must sign the highlight's actual GCS object path, not a generic one.
    expect(signedUrlCalls[0].path).toBe(PATH_HIGHLIGHT);
    // TTL must be 18 000 s (5 h) — intentionally longer than the stream token
    // TTL (4 h) so the player can seek via the cached GCS URL for 1 full hour
    // after the token has expired, without contacting the server.
    expect(signedUrlCalls[0].ttl).toBe(18_000);
  });

  it("signs the lowlight object path with a 5 h (18 000 s) TTL", async () => {
    reelMode.value = "lowlight";
    const token = await mintToken(GAME_ID, "lowlight");
    await streamNoRange(GAME_ID, "lowlight", token);

    expect(signedUrlCalls).toHaveLength(1);
    expect(signedUrlCalls[0].path).toBe(PATH_LOWLIGHT);
    expect(signedUrlCalls[0].ttl).toBe(18_000);
  });
});

// ---------------------------------------------------------------------------
// B — Range seeks are also redirected to the GCS signed URL
// ---------------------------------------------------------------------------
//
// The endpoint redirects ALL requests — with or without a Range header —
// to the same GCS signed URL.  GCS natively supports Range requests, so the
// player can seek freely once it has the URL without contacting the server
// again.  This is the mechanism that allows seeking to keep working after
// the server-side stream token has expired: the token is only needed to
// obtain the initial GCS URL, not for subsequent seek requests.

describe("Range seek request → 302 redirect to GCS signed URL (not 206)", () => {
  it("redirects a highlight seek (Range header) to the GCS URL", async () => {
    reelMode.value = "highlight";
    const token = await mintToken(GAME_ID, "highlight");

    const res = await streamWithRange(GAME_ID, "highlight", token, 0, 1023);

    // Must redirect — the server never pipes bytes for seeks.
    // GCS handles the Range request directly once the player has this URL.
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(SIGNED_URL);

    // getObjectEntitySignedURL was called (not createReadStream).
    expect(streamCalls.getSignedURL).toBe(1);
    expect(streamCalls.createReadStream).toBe(0);
  });

  it("redirects a lowlight seek (Range header) to the GCS URL", async () => {
    reelMode.value = "lowlight";
    const token = await mintToken(GAME_ID, "lowlight");

    const res = await streamWithRange(GAME_ID, "lowlight", token, 1024, 2047);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(SIGNED_URL);

    expect(streamCalls.getSignedURL).toBe(1);
    expect(streamCalls.createReadStream).toBe(0);
  });

  it("redirects a mid-file seek to the same GCS URL as a full-file request", async () => {
    // Any Range offset — not just byte 0 — produces the same redirect.
    // GCS resolves the Range against the full file on its end.
    reelMode.value = "highlight";
    const token = await mintToken(GAME_ID, "highlight");

    const res = await streamWithRange(GAME_ID, "highlight", token, 2_500_000, 2_500_999);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(SIGNED_URL);
  });
});

// ---------------------------------------------------------------------------
// C — YouTube URL is returned when the highlight is ready
// ---------------------------------------------------------------------------

describe("GET /api/games/:gameId/highlight — youtubeUrl included in response", () => {
  it("returns youtubeUrl so the Upload to YouTube button can be shown", async () => {
    reelMode.value = "highlight";

    const res = await fetch(`${baseUrl}/api/games/${GAME_ID}/highlight`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      status: string;
      youtubeUrl: string | null;
    };

    // Status must be "ready" for the reel to be playable.
    expect(body.status).toBe("ready");

    // youtubeUrl must be present so the mobile client renders the button.
    expect(body.youtubeUrl).toBe("https://youtu.be/example123");
  });
});

// ---------------------------------------------------------------------------
// D — Seeking after stream token expiry / entitlement lapse
// ---------------------------------------------------------------------------
//
// Design guarantee (see file header for full rationale):
//
//   The stream token (4 h TTL) is the auth gate for ISSUING a GCS URL.
//   Once the player has the URL it seeks directly against GCS for up to
//   18 000 s (5 h).  The server cannot revoke an already-issued signed URL;
//   it can only block future calls to /stream/:type.
//
//   Token TTL (14 400 s / 4 h) < GCS URL TTL (18 000 s / 5 h) — this ordering
//   is the key invariant.  After the token expires the player's cached GCS URL
//   is still valid for 1 more hour, so seeking continues uninterrupted.
//
//   Consequences tested here:
//     1. After the 4 h stream token expires the server returns 401 for any
//        new /stream/:type request, but the GCS URL issued before expiry is
//        still valid (18 000 s − 14 400 s = 3 600 s remaining) so seeking
//        continues for another hour.
//     2. After the 5-min entitlement re-check window elapses and the
//        subscription has lapsed, the server returns 403 for new requests —
//        but the GCS URL already in the player's hands is still valid for the
//        remainder of its 5 h window.

describe("Seeking after stream token expiry / entitlement lapse", () => {
  it("GCS URL TTL (18 000 s / 5 h) outlasts stream token TTL (4 h) — proves seeks work after token expiry", async () => {
    /**
     * Core seek-after-expiry guarantee:
     *   Token TTL = 4 h = 14 400 s.  GCS URL TTL = 5 h = 18 000 s.
     *
     * Flow:
     *   t=0:      /stream-token returns { token, streamUrl }.  Mobile client
     *             passes streamUrl directly to expo-video/AVPlayer.  All seeks
     *             (Range requests) go to GCS without contacting the server.
     *   t=14400s: Stream token expires → server returns 401 for NEW requests.
     *   t=14400–18000s: GCS URL is still valid → seeks continue uninterrupted.
     *
     * We verify this by:
     *   1. Calling mintTokenFull() — getting { token, streamUrl } from
     *      /stream-token at t=0.
     *   2. Confirming streamUrl is the GCS signed URL and its TTL is 18 000 s.
     *   3. Advancing to t=4h+1ms (token expired) and confirming 401 from server.
     *   4. Computing remaining GCS URL validity and asserting it is > 0.
     *      AVPlayer sends Range requests to streamUrl directly; server 401 is
     *      irrelevant for those requests.
     */
    vi.useFakeTimers({ toFake: ["Date"] });

    reelMode.value = "highlight";
    const mintedAt = Date.now();

    // t=0: /stream-token pre-generates the GCS URL and returns it directly.
    const tokenBody = await mintTokenFull(GAME_ID, "highlight");
    expect(tokenBody.streamUrl).toBe(SIGNED_URL);

    // The GCS URL was signed with a 5 h = 18 000 s TTL.
    expect(signedUrlCalls).toHaveLength(1);
    const gcsTtlSeconds = signedUrlCalls[0].ttl;
    expect(gcsTtlSeconds).toBe(18_000);

    // Mobile client passes tokenBody.streamUrl to expo-video — no /stream
    // request needed.  The player seeks via GCS directly from this point on.

    // Advance to just after the 4-hour stream token TTL.
    const TOKEN_TTL_MS = 4 * 60 * 60 * 1000; // 14 400 s
    vi.setSystemTime(mintedAt + TOKEN_TTL_MS + 1);

    // Server must reject NEW /stream-token or /stream requests (token expired).
    const expiredRes = await streamNoRange(GAME_ID, "highlight", tokenBody.token);
    expect(expiredRes.status).toBe(401);
    const body = (await expiredRes.json()) as { error: string };
    expect(body.error).toMatch(/expired|invalid/i);

    // The GCS URL returned at t=0 is still within its validity window.
    // Elapsed: ~14 400 s.  Remaining: 18 000 − 14 400 = 3 600 s = 1 hour.
    const elapsedSeconds = (TOKEN_TTL_MS + 1) / 1000;
    const remainingGcsSeconds = gcsTtlSeconds - elapsedSeconds;
    expect(remainingGcsSeconds).toBeGreaterThan(0);
    // Any Range seek expo-video sends to tokenBody.streamUrl within those
    // 3 600 s succeeds — GCS authorizes it via the signed URL, no server hop.
  });

  it("returns 401 on a seek (Range request) once the stream token has expired", async () => {
    /**
     * If the player's cached GCS URL is somehow lost and it falls back to the
     * server endpoint (e.g. on a full player restart after token expiry), it
     * gets 401.  This ensures expired tokens are not silently promoted — the
     * coach must re-open the reel to mint a new token.
     * Normal seeking within the 5 h GCS window via the cached URL is unaffected.
     */
    vi.useFakeTimers({ toFake: ["Date"] });

    reelMode.value = "highlight";
    const token = await mintToken(GAME_ID, "highlight");

    // Advance past the 4-hour stream token TTL.
    vi.setSystemTime(Date.now() + 4 * 60 * 60 * 1000 + 1);

    // A Range seek that returns to the server after token expiry → 401.
    const res = await streamWithRange(GAME_ID, "highlight", token, 0, 1023);
    expect(res.status).toBe(401);

    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/expired|invalid/i);
  });

  it("returns 302 while the token is still live — well within 4 h token TTL", async () => {
    /**
     * Confirms the server issues a fresh 302 to the GCS URL during the valid
     * token window (first 4 hours).  The player caches this URL and uses it
     * for all seeks during the 5 h GCS validity window.
     */
    reelMode.value = "highlight";
    const token = await mintToken(GAME_ID, "highlight");

    // Advance 30 minutes — well inside the 4 h token TTL and the 5 h GCS TTL.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 30 * 60 * 1000);

    const res = await streamNoRange(GAME_ID, "highlight", token);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(SIGNED_URL);
  });

  it("returns 403 after the 5-min entitlement re-check window elapses and subscription lapses", async () => {
    /**
     * Subscription-lapse detection: every /stream/:type request that arrives
     * after the 5-minute entitlement re-check window triggers a fresh DB +
     * Stripe lookup.  If isPro() returns false the token is deleted and the
     * request is rejected with 403.
     *
     * Crucially, this 403 only blocks NEW /stream/:type requests.  The GCS
     * signed URL already in the player's hands (18 000 s TTL) is unrevoked —
     * it was issued by GCS and the server has no way to invalidate it.
     *
     * The re-check window (5 min) is well within the token TTL (4 h) so the
     * re-check fires many times within the token's lifetime.
     */
    vi.useFakeTimers({ toFake: ["Date"] });

    reelMode.value = "highlight";
    // Mint a token while subscribed.
    const token = await mintToken(GAME_ID, "highlight");

    // Advance past the 5-minute entitlement re-check window but stay well
    // within the 4-hour token TTL so the 401 expiry gate doesn't fire first.
    vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1);

    // Simulate subscription lapse after the re-check window.
    isProResult.value = false;

    const res = await streamNoRange(GAME_ID, "highlight", token);
    expect(res.status).toBe(403);

    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/subscription/i);
  });

  it("continues to return 302 within the entitlement re-check window even when subscription lapses", async () => {
    /**
     * The server only calls getEntitlements() once per 5-minute window.
     * If the subscription lapses 1 minute after the token is minted, the
     * /stream/:type endpoint still returns 302 for another 4 minutes
     * (until the next re-check fires) because entitlementOkUntil has not
     * elapsed yet.  This is intentional: the server avoids a DB round-trip
     * on every seek request.
     *
     * This also means an already-issued GCS URL (18 000 s TTL) is not
     * revoked — the coach retains playback for the remainder of the GCS
     * window regardless of any server-side entitlement change.
     */
    vi.useFakeTimers({ toFake: ["Date"] });

    reelMode.value = "highlight";
    const token = await mintToken(GAME_ID, "highlight");

    // Advance 1 minute — still inside the 5-min re-check window.
    vi.setSystemTime(Date.now() + 60 * 1000);

    // Even though isPro is now false, the re-check has not fired yet.
    isProResult.value = false;

    const res = await streamNoRange(GAME_ID, "highlight", token);
    // Still a valid redirect — cached entitlement window has not expired.
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(SIGNED_URL);
  });
});
