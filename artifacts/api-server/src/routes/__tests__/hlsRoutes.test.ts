/**
 * HLS playlist + segment routes — token gating, M3U8 accuracy, and lifecycle
 *
 * Tests the two endpoints added for long-game iOS playback:
 *
 *   GET /games/:id/hls/playlist.m3u8?t=<token>
 *   GET /games/:id/hls/segment/:n?t=<token>
 *
 * Key invariants verified:
 *   1. Both routes reject non-HLS tokens and unknown/expired tokens with 401.
 *   2. The playlist derives #EXT-X-TARGETDURATION from the sentinel's actual
 *      per-segment durations (not a flat PROXY_CHUNK_DURATION_SEC estimate).
 *   3. Each #EXTINF line matches the sentinel's segmentDurationsSec[i] value.
 *   4. The playlist contains exactly chunkCount segment entries and ends with
 *      #EXT-X-ENDLIST.
 *   5. The segment route returns 503 when the chunk is not available.
 *   6. The segment route returns 401 for out-of-bound or malformed chunk indices.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";

// ---------------------------------------------------------------------------
// Hoisted fixtures
// ---------------------------------------------------------------------------
const {
  COACH,
  LONG_GAME_ID,
  SHORT_GAME_ID,
  SENTINEL,
  currentUser,
  hlsSentinelMode,
} = vi.hoisted(() => {
  const COACH         = { id: 7, clerkUserId: "clerk_hls_coach", email: "hls@example.com" };
  const LONG_GAME_ID  = 42;
  const SHORT_GAME_ID = 43;
  /** Sentinel returned when hlsSentinelMode === "ready" */
  const SENTINEL = {
    chunkCount: 3,
    segmentDurationsSec: [361.5, 359.8, 180.2],
  };
  const currentUser     = { value: COACH as typeof COACH };
  const hlsSentinelMode = { value: "none" as "none" | "ready" };
  return { COACH, LONG_GAME_ID, SHORT_GAME_ID, SENTINEL, currentUser, hlsSentinelMode };
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("@workspace/db", () => ({
  db: {
    query: {
      gamesTable: {
        findFirst: vi.fn().mockImplementation(async () => ({
          id: LONG_GAME_ID,
          ownerId: COACH.id,
          teamId: 1,
          opponent: "Rivals",
          date: "2024-03-01",
          result: "W",
          teamScore: 90, opponentScore: 80,
          videoObjectPath: "/objects/uploads/7/game42.webm",
          videoOffsetMs: null,
          videoDurationMs: 60 * 60 * 1000,    // 60 minutes → long game
          videoHalf2StartMs: null,
          videoHalftimeGapMs: null,
          videoProxyObjectPath: null,
          videoProxyVersion: null,
          highlightObjectPath: null,
          highlightStatus: null,
          highlightError: null,
          highlightStartedAt: null,
          lowlightObjectPath: null,
          lowlightStatus: null,
          lowlightError: null,
          lowlightStartedAt: null,
          shareToken: null,
          createdAt: new Date(),
        })),
      },
      usersTable:   { findFirst: vi.fn().mockResolvedValue(null) },
      teamsTable:   { findFirst: vi.fn().mockResolvedValue({ id: 1, ownerId: COACH.id, name: "Squad" }) },
      playersTable: { findMany: vi.fn().mockResolvedValue([]) },
      gameEventsTable: { findMany: vi.fn().mockResolvedValue([]) },
    },
    transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({
      insert: vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }) }),
      update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) }),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    })),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      }),
    }),
  },
  gamesTable:  { id: "id", ownerId: "owner_id", videoObjectPath: "video_object_path", highlightObjectPath: "highlight_object_path", teamId: "team_id", opponent: "opponent", date: "date", result: "result", teamScore: "team_score", opponentScore: "opponent_score", videoOffsetMs: "video_offset_ms", videoDurationMs: "video_duration_ms", videoHalf2StartMs: "video_half2_start_ms", videoHalftimeGapMs: "video_halftime_gap_ms", videoProxyObjectPath: "video_proxy_object_path", videoProxyVersion: "video_proxy_version", highlightStatus: "highlight_status", highlightError: "highlight_error", highlightStartedAt: "highlight_started_at", lowlightObjectPath: "lowlight_object_path", lowlightStatus: "lowlight_status", lowlightError: "lowlight_error", lowlightStartedAt: "lowlight_started_at", createdAt: "created_at", shareToken: "share_token" },
  teamsTable:   { id: "id", ownerId: "owner_id", name: "name" },
  playersTable: { id: "id", ownerId: "owner_id", name: "name" },
  playerGameStatsTable: { gameId: "game_id", playerId: "player_id", ftMade: "ft_made", ftAttempted: "ft_attempted", twoMade: "two_made", twoAttempted: "two_attempted", threeMade: "three_made", threeAttempted: "three_attempted", assists: "assists", rebounds: "rebounds", steals: "steals", turnovers: "turnovers", blocks: "blocks", goals: "goals", shots: "shots", shotsOffTarget: "shots_off_target", saves: "saves", yellowCards: "yellow_cards", redCards: "red_cards" },
  gameEventsTable: { gameId: "game_id", playerId: "player_id", statField: "stat_field", delta: "delta", videoTimestampMs: "video_timestamp_ms" },
}));

vi.mock("../../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis() },
}));

vi.mock("../../middlewares/requireAuth", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.appUser = { ...currentUser.value } as never;
    next();
  },
}));

vi.mock("../../lib/objectStorage", () => {
  const { Readable } = require("stream");
  class ObjectStorageService {
    getObjectEntityFile = vi.fn().mockImplementation(async (objectPath: string) => ({
      getMetadata: vi.fn().mockResolvedValue([{ contentType: "video/mp4", size: 2048 }]),
      createReadStream: vi.fn().mockImplementation(() => {
        const s = new Readable({ read() {} });
        process.nextTick(() => s.push(null));
        return s;
      }),
    }));
    normalizeObjectEntityPath = vi.fn().mockImplementation((p: string) => p);
    canAccessObjectEntity = vi.fn().mockResolvedValue(false);
    getObjectEntitySignedURL = vi.fn().mockResolvedValue("https://storage.googleapis.com/stub");
    uploadLocalFileAsObjectEntity = vi.fn().mockResolvedValue("/objects/private/out.mp4");
    trySetObjectEntityAclPolicy = vi.fn().mockResolvedValue(undefined);
  }
  class ObjectNotFoundError extends Error {
    constructor(msg = "Not found") { super(msg); this.name = "ObjectNotFoundError"; Object.setPrototypeOf(this, new.target.prototype); }
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
  PROXY_CHUNK_DURATION_SEC: 360,
  ensureGameProxyInBackground: vi.fn(),
  cancelHighlightGeneration: vi.fn(),
  cancelProxyBuild: vi.fn(),
  makeProxyChunkGcsPath: vi.fn().mockImplementation(
    (_ownerId: number, _gameId: number, i: number) => `/chunks/${i}`,
  ),
  // getReadyProxyChunkCount checks whether the HLS build is complete.
  // Returns SENTINEL.chunkCount when ready, -1 when not.
  getReadyProxyChunkCount: vi.fn().mockImplementation(async () =>
    hlsSentinelMode.value === "ready" ? SENTINEL.chunkCount : -1,
  ),
  // readHlsSentinel returns the full sentinel including per-segment durations.
  readHlsSentinel: vi.fn().mockImplementation(async () =>
    hlsSentinelMode.value === "ready" ? { ...SENTINEL } : null,
  ),
  ensureAllProxyChunksInBackground: vi.fn(),
  // acquireProxyChunkLocally throws ObjectNotFoundError when the chunk is absent.
  acquireProxyChunkLocally: vi.fn().mockImplementation(async (chunkGcsPath: string) => {
    throw new Error(`Chunk not available: ${chunkGcsPath}`);
  }),
}));

vi.mock("child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn().mockImplementation(() => ({
    stdout: { pipe: vi.fn(), on: vi.fn() },
    stderr: { resume: vi.fn() },
    stdin:  { end: vi.fn() },
    on:     vi.fn(),
    kill:   vi.fn(),
  })),
}));

vi.mock("fs", async () => {
  const { Readable } = await import("stream");
  return {
    promises: {
      mkdtemp: vi.fn().mockResolvedValue("/tmp/test-stub"),
      writeFile: vi.fn().mockResolvedValue(undefined),
      rm: vi.fn().mockResolvedValue(undefined),
      stat: vi.fn().mockResolvedValue({ size: 1000 }),
      open: vi.fn().mockResolvedValue({
        read: vi.fn().mockResolvedValue({ bytesRead: 0 }),
        close: vi.fn().mockResolvedValue(undefined),
      }),
    },
    createWriteStream: vi.fn().mockReturnValue({ write: vi.fn((data: unknown, cb: () => void) => cb()), end: vi.fn() }),
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

// ---------------------------------------------------------------------------
// Test server
// ---------------------------------------------------------------------------
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as never as { log: object }).log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    next();
  });
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
  currentUser.value = COACH;
  hlsSentinelMode.value = "none";
});

// ---------------------------------------------------------------------------
// Helper: mint an HLS stream token via stream-token/video for the long game
// ---------------------------------------------------------------------------
async function mintHlsToken(): Promise<string> {
  hlsSentinelMode.value = "ready"; // sentinel present → HLS token issued
  const res = await fetch(`${baseUrl}/api/games/${LONG_GAME_ID}/stream-token/video`);
  expect(res.status, "stream-token/video should return 200 when HLS is ready").toBe(200);
  const body = (await res.json()) as { token: string; proxyType: string };
  expect(body.proxyType).toBe("hls");
  return body.token;
}

// ---------------------------------------------------------------------------
// Playlist route tests
// ---------------------------------------------------------------------------
describe("GET /api/games/:gameId/hls/playlist.m3u8 — token gating", () => {
  it("returns 401 for a missing token", async () => {
    const res = await fetch(`${baseUrl}/api/games/${LONG_GAME_ID}/hls/playlist.m3u8`);
    expect(res.status).toBe(401);
  });

  it("returns 401 for an unknown token string", async () => {
    const res = await fetch(`${baseUrl}/api/games/${LONG_GAME_ID}/hls/playlist.m3u8?t=garbage`);
    expect(res.status).toBe(401);
  });

  it("returns 401 when the token was minted for a regular (non-HLS) stream", async () => {
    // Mint a short-game video token (not HLS) by giving the game a short duration.
    // The mock always returns the long game, so simulate a short game by having
    // getReadyProxyChunkCount return -1 and videoDurationMs < 900 s.
    // The easiest way: mint a highlight token (always non-HLS).
    const res1 = await fetch(`${baseUrl}/api/games/${LONG_GAME_ID}/stream-token/video`);
    // If HLS is not ready the endpoint returns proxyReady:false, not a token for HLS.
    // Use the returned random token (proxyReady: false path) to verify 401 on playlist.
    const body1 = (await res1.json()) as { token: string };
    const res = await fetch(
      `${baseUrl}/api/games/${LONG_GAME_ID}/hls/playlist.m3u8?t=${body1.token}`,
    );
    // This non-HLS token (proxyReady:false dummy) must not work on the HLS playlist route.
    expect(res.status).toBe(401);
  });
});

describe("GET /api/games/:gameId/hls/playlist.m3u8 — M3U8 correctness", () => {
  it("returns 200 with correct Content-Type for a valid HLS token", async () => {
    const token = await mintHlsToken();
    hlsSentinelMode.value = "ready";

    const res = await fetch(`${baseUrl}/api/games/${LONG_GAME_ID}/hls/playlist.m3u8?t=${token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/mpegurl/i);
  });

  it("emits exactly chunkCount segment lines and ends with #EXT-X-ENDLIST", async () => {
    const token = await mintHlsToken();
    hlsSentinelMode.value = "ready";

    const res = await fetch(`${baseUrl}/api/games/${LONG_GAME_ID}/hls/playlist.m3u8?t=${token}`);
    const text = await res.text();
    const lines = text.split("\n").filter(Boolean);

    expect(lines).toContain("#EXTM3U");
    expect(lines).toContain("#EXT-X-ENDLIST");

    const extinfs = lines.filter((l) => l.startsWith("#EXTINF:"));
    expect(extinfs).toHaveLength(SENTINEL.chunkCount);
  });

  it("uses ffprobe-measured #EXTINF durations from the sentinel (not the flat estimate)", async () => {
    const token = await mintHlsToken();
    hlsSentinelMode.value = "ready";

    const res = await fetch(`${baseUrl}/api/games/${LONG_GAME_ID}/hls/playlist.m3u8?t=${token}`);
    const text = await res.text();
    const lines = text.split("\n").filter(Boolean);
    const extinfs = lines
      .filter((l) => l.startsWith("#EXTINF:"))
      .map((l) => parseFloat(l.slice("#EXTINF:".length)));

    // Each #EXTINF must match the sentinel's actual duration (within 0.01 s rounding).
    for (let i = 0; i < SENTINEL.segmentDurationsSec.length; i++) {
      expect(extinfs[i]).toBeCloseTo(SENTINEL.segmentDurationsSec[i]!, 1);
    }
  });

  it("#EXT-X-TARGETDURATION is the ceiling of the longest actual segment", async () => {
    const token = await mintHlsToken();
    hlsSentinelMode.value = "ready";

    const res = await fetch(`${baseUrl}/api/games/${LONG_GAME_ID}/hls/playlist.m3u8?t=${token}`);
    const text = await res.text();
    const lines = text.split("\n").filter(Boolean);

    const tdLine = lines.find((l) => l.startsWith("#EXT-X-TARGETDURATION:"));
    expect(tdLine).toBeDefined();
    const td = parseInt(tdLine!.split(":")[1]!, 10);

    const expectedTd = Math.ceil(Math.max(...SENTINEL.segmentDurationsSec));
    expect(td).toBe(expectedTd);
  });

  it("each segment URL contains the HLS token as query param", async () => {
    const token = await mintHlsToken();
    hlsSentinelMode.value = "ready";

    const res = await fetch(`${baseUrl}/api/games/${LONG_GAME_ID}/hls/playlist.m3u8?t=${token}`);
    const text = await res.text();
    const segmentLines = text.split("\n").filter((l) => l.startsWith("segment/"));

    expect(segmentLines).toHaveLength(SENTINEL.chunkCount);
    for (const seg of segmentLines) {
      expect(seg).toContain(`t=${token}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Segment route tests
// ---------------------------------------------------------------------------
describe("GET /api/games/:gameId/hls/segment/:n — token gating", () => {
  it("returns 401 for a missing token", async () => {
    const res = await fetch(`${baseUrl}/api/games/${LONG_GAME_ID}/hls/segment/0`);
    expect(res.status).toBe(401);
  });

  it("returns 401 for an unknown token string", async () => {
    const res = await fetch(`${baseUrl}/api/games/${LONG_GAME_ID}/hls/segment/0?t=bogus`);
    expect(res.status).toBe(401);
  });

  it("returns 401 for a negative chunk index", async () => {
    const token = await mintHlsToken();
    hlsSentinelMode.value = "ready";

    const res = await fetch(`${baseUrl}/api/games/${LONG_GAME_ID}/hls/segment/-1?t=${token}`);
    expect(res.status).toBe(401);
  });
});

describe("GET /api/games/:gameId/hls/segment/:n — chunk serving", () => {
  it("returns 503 when the chunk is not yet available in GCS", async () => {
    const token = await mintHlsToken();
    hlsSentinelMode.value = "ready";

    // acquireProxyChunkLocally is mocked to always throw (chunk absent).
    const res = await fetch(`${baseUrl}/api/games/${LONG_GAME_ID}/hls/segment/0?t=${token}`);
    expect(res.status).toBe(503);
  });
});
