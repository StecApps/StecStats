/**
 * Highlight / lowlight streaming proxy fix — regression test
 *
 * Before the fix the /games/:gameId/stream/:type endpoint piped the full
 * video file through the Replit proxy, which kills large responses after
 * ~1–2 s.  The fix makes the endpoint redirect full-file requests (no
 * Range header) to a short-lived GCS signed URL so the player downloads
 * directly from GCS.  Range requests (seeking) still go through
 * createReadStream.
 *
 * This suite verifies:
 *
 *   A. FULL-FILE → 302 signed-URL redirect (highlight + lowlight)
 *      No Range header in the request must yield a 302 redirect whose
 *      Location is the pre-generated GCS signed URL, not a streamed body.
 *
 *   B. RANGE REQUEST → 206 partial content (highlight + lowlight)
 *      A Range header must yield a 206 with the correct Content-Range
 *      header, served via createReadStream (not a redirect).
 *
 *   C. YouTube URL returned when highlight is ready
 *      GET /games/:gameId/highlight must include a youtubeUrl field so the
 *      mobile client can show the Upload to YouTube button.
 *
 * No real GCS bucket, database, or camera access is required — all I/O
 * layers are replaced with in-memory mocks following the pattern in
 * streamTokenSecurity.test.ts.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
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
} = vi.hoisted(() => {
  const COACH_A = { id: 1, clerkUserId: "clerk_coach_a", email: "coach@example.com" };
  const GAME_ID = 42;
  const PATH_HIGHLIGHT = "/objects/private/highlight-42.mp4";
  const PATH_LOWLIGHT  = "/objects/private/lowlight-42.mp4";
  const currentUser = { value: COACH_A as typeof COACH_A };
  const reelMode = { value: "highlight" as "highlight" | "lowlight" | "no-reel" };
  const SIGNED_URL = "https://storage.googleapis.com/bucket/highlight-42.mp4?X-Goog-Signature=abc";
  return { COACH_A, GAME_ID, PATH_HIGHLIGHT, PATH_LOWLIGHT, currentUser, reelMode, SIGNED_URL };
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
  isPro: vi.fn().mockReturnValue(true),
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
});

beforeEach(() => {
  currentUser.value = COACH_A;
  lastStreamObjectPath.value = "";
  streamCalls.createReadStream = 0;
  streamCalls.getSignedURL = 0;
  signedUrlCalls.length = 0;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function mintToken(gameId: number, type: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/games/${gameId}/stream-token/${type}`);
  if (!res.ok) throw new Error(`stream-token returned ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { token: string };
  return body.token;
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

async function streamWithRange(
  gameId: number,
  type: string,
  token: string,
  start: number,
  end: number,
) {
  return fetch(`${baseUrl}/api/games/${gameId}/stream/${type}?t=${token}`, {
    headers: { Range: `bytes=${start}-${end}` },
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

  it("signs the highlight object path (not a generic path) with a TTL ≤ 120 s", async () => {
    reelMode.value = "highlight";
    const token = await mintToken(GAME_ID, "highlight");
    await streamNoRange(GAME_ID, "highlight", token);

    expect(signedUrlCalls).toHaveLength(1);
    // Must sign the highlight's actual GCS object path, not a generic one.
    expect(signedUrlCalls[0].path).toBe(PATH_HIGHLIGHT);
    // TTL must be short so a captured redirect URL can't be replayed after buffering.
    expect(signedUrlCalls[0].ttl).toBeGreaterThan(0);
    expect(signedUrlCalls[0].ttl).toBeLessThanOrEqual(120);
  });

  it("signs the lowlight object path with a TTL ≤ 120 s", async () => {
    reelMode.value = "lowlight";
    const token = await mintToken(GAME_ID, "lowlight");
    await streamNoRange(GAME_ID, "lowlight", token);

    expect(signedUrlCalls).toHaveLength(1);
    expect(signedUrlCalls[0].path).toBe(PATH_LOWLIGHT);
    expect(signedUrlCalls[0].ttl).toBeGreaterThan(0);
    expect(signedUrlCalls[0].ttl).toBeLessThanOrEqual(120);
  });
});

// ---------------------------------------------------------------------------
// B — Range requests (seeking) served via createReadStream (206 partial)
// ---------------------------------------------------------------------------

describe("Range request (seeking) → 206 partial content via createReadStream", () => {
  it("returns 206 with correct Content-Range for a highlight seek", async () => {
    reelMode.value = "highlight";
    const token = await mintToken(GAME_ID, "highlight");

    const res = await streamWithRange(GAME_ID, "highlight", token, 0, 1023);

    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-1023/5000000");

    // createReadStream was used (not a signed-URL redirect).
    expect(streamCalls.createReadStream).toBe(1);
    expect(streamCalls.getSignedURL).toBe(0);
  });

  it("returns 206 with correct Content-Range for a lowlight seek", async () => {
    reelMode.value = "lowlight";
    const token = await mintToken(GAME_ID, "lowlight");

    const res = await streamWithRange(GAME_ID, "lowlight", token, 1024, 2047);

    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 1024-2047/5000000");

    expect(streamCalls.createReadStream).toBe(1);
    expect(streamCalls.getSignedURL).toBe(0);
  });

  it("advertises Accept-Ranges: bytes so the player knows seeking is supported", async () => {
    reelMode.value = "highlight";
    const token = await mintToken(GAME_ID, "highlight");

    const res = await streamWithRange(GAME_ID, "highlight", token, 0, 99);

    expect(res.headers.get("accept-ranges")).toBe("bytes");
  });

  it("serves mid-file range correctly (not just byte 0)", async () => {
    reelMode.value = "highlight";
    const token = await mintToken(GAME_ID, "highlight");

    const midStart = 2_500_000;
    const midEnd   = 2_500_999;
    const res = await streamWithRange(GAME_ID, "highlight", token, midStart, midEnd);

    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes ${midStart}-${midEnd}/5000000`);
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
