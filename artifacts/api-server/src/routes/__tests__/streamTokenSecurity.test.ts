/**
 * Stream token security — expiry and cross-game isolation
 *
 * Verifies two properties of the /stream-token + /stream route pair:
 *
 *   1. EXPIRY: A token that has aged past its TTL is rejected with 401.
 *      The /stream/:type endpoint checks `Date.now() > entry.expiresAt`;
 *      we advance fake timers past the TTL and confirm the gate fires.
 *
 *   2. CROSS-GAME ISOLATION: A token minted for game A's highlight objectPath
 *      is bound to that exact path.  Substituting game B's ID in the URL
 *      does NOT cause the server to serve game B's content — the token's
 *      objectPath is authoritative, and game B's video path is unreachable
 *      with a token that was never scoped to it.
 *
 * No real GCS bucket or database is required — all I/O layers are replaced
 * with in-memory mocks following the pattern established by
 * gameVideoHijack.test.ts and gameReadAcl.test.ts.
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
  GAME_A_ID,
  GAME_B_ID,
  PATH_A_HIGHLIGHT,
  PATH_B_VIDEO,
  currentUser,
  /**
   * Controls what db.query.gamesTable.findFirst returns.
   * "game-a" → returns a game row for game A owned by Coach A (highlight ready, video present).
   * "game-b" → returns a game row for game B owned by Coach A (video present, highlight not ready).
   * "not-found" → returns undefined.
   */
  gameFinderMode,
} = vi.hoisted(() => {
  const COACH_A = { id: 1, clerkUserId: "clerk_coach_a", email: "coach-a@example.com" };
  const GAME_A_ID = 10;
  const GAME_B_ID = 20;
  const PATH_A_HIGHLIGHT = "/objects/private/game-a-highlight.mp4";
  const PATH_B_VIDEO     = "/objects/private/game-b-video.mp4";
  const currentUser      = { value: COACH_A as typeof COACH_A };
  const gameFinderMode   = { value: "game-a" as "game-a" | "game-b" | "not-found" };
  return { COACH_A, GAME_A_ID, GAME_B_ID, PATH_A_HIGHLIGHT, PATH_B_VIDEO, currentUser, gameFinderMode };
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("@workspace/db", () => ({
  db: {
    query: {
      gamesTable: {
        findFirst: vi.fn().mockImplementation(async () => {
          if (gameFinderMode.value === "game-a") {
            return {
              id: GAME_A_ID,
              ownerId: COACH_A.id,
              teamId: 1,
              opponent: "Rivals",
              date: "2024-01-15",
              result: "W",
              teamScore: 80,
              opponentScore: 70,
              videoObjectPath: "/objects/private/game-a-video.mp4",
              videoOffsetMs: null,
              videoDurationMs: null,
              videoHalf2StartMs: null,
              videoHalftimeGapMs: null,
              videoProxyObjectPath: null,
              videoProxyVersion: null,
              highlightObjectPath: PATH_A_HIGHLIGHT,
              highlightStatus: "ready",
              highlightError: null,
              highlightStartedAt: null,
              lowlightObjectPath: null,
              lowlightStatus: null,
              lowlightError: null,
              lowlightStartedAt: null,
              shareToken: null,
              createdAt: new Date(),
            };
          }
          if (gameFinderMode.value === "game-b") {
            return {
              id: GAME_B_ID,
              ownerId: COACH_A.id,
              teamId: 1,
              opponent: "Others",
              date: "2024-02-01",
              result: "L",
              teamScore: 60,
              opponentScore: 75,
              videoObjectPath: PATH_B_VIDEO,
              videoOffsetMs: null,
              videoDurationMs: null,
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
            };
          }
          return undefined;
        }),
      },
      teamsTable: {
        findFirst: vi.fn().mockResolvedValue({ id: 1, ownerId: COACH_A.id, name: "Test Squad" }),
      },
      playersTable: { findMany: vi.fn().mockResolvedValue([]) },
      gameEventsTable: { findMany: vi.fn().mockResolvedValue([]) },
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
    highlightStatus: "highlight_status",
    highlightError: "highlight_error",
    highlightStartedAt: "highlight_started_at",
    lowlightObjectPath: "lowlight_object_path",
    lowlightStatus: "lowlight_status",
    lowlightError: "lowlight_error",
    lowlightStartedAt: "lowlight_started_at",
    createdAt: "created_at",
    shareToken: "share_token",
  },
  teamsTable:  { id: "id", ownerId: "owner_id", name: "name" },
  playersTable: { id: "id", ownerId: "owner_id", name: "name" },
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

/**
 * Track which objectPath was last requested so cross-game tests can assert
 * that the server used the token's bound path, not the URL's gameId.
 */
const lastObjectPathRequested = { value: "" as string };

vi.mock("../../lib/objectStorage", () => {
  const { Readable } = require("stream");

  class ObjectStorageService {
    getObjectEntityFile = vi.fn().mockImplementation(async (objectPath: string) => {
      lastObjectPathRequested.value = objectPath;
      return {
        getMetadata: vi.fn().mockResolvedValue([{ contentType: "video/mp4", size: 1024 }]),
        createReadStream: vi.fn().mockImplementation(() => {
          const s = new Readable({ read() {} });
          process.nextTick(() => s.push(null)); // immediate EOF
          return s;
        }),
      };
    });
    normalizeObjectEntityPath = vi.fn().mockImplementation((p: string) => p);
    canAccessObjectEntity = vi.fn().mockResolvedValue(false);
    getObjectEntitySignedURL = vi.fn().mockResolvedValue("https://storage.googleapis.com/stub");
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
  ensureGameProxyInBackground: vi.fn(),
  cancelHighlightGeneration: vi.fn(),
  cancelProxyBuild: vi.fn(),
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
      stat: vi.fn().mockResolvedValue({ size: 1000 }),
      open: vi.fn().mockResolvedValue({
        read: vi.fn().mockResolvedValue({ bytesRead: 0 }),
        close: vi.fn().mockResolvedValue(undefined),
      }),
    },
    createWriteStream: vi.fn().mockReturnValue({
      write: vi.fn((data: any, cb: () => void) => cb()),
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
// Real imports (after mocks are registered)
// ---------------------------------------------------------------------------
import gamesRouter from "../games";

// ---------------------------------------------------------------------------
// Express app shared across all tests
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
  gameFinderMode.value = "game-a";
  lastObjectPathRequested.value = "";
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mint a stream token for the given gameId and type. */
async function mintToken(gameId: number, type: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/games/${gameId}/stream-token/${type}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { token: string };
  expect(typeof body.token).toBe("string");
  return body.token;
}

/** Issue a stream request using the given token against the given gameId/type. */
async function streamRequest(gameId: number, type: string, token: string) {
  return fetch(`${baseUrl}/api/games/${gameId}/stream/${type}?t=${token}`);
}

// ---------------------------------------------------------------------------
// Tests — token expiry
// ---------------------------------------------------------------------------

describe("GET /api/games/:gameId/stream/:type — expired token is rejected", () => {
  it("returns 200 for a freshly minted token", async () => {
    gameFinderMode.value = "game-a";
    const token = await mintToken(GAME_A_ID, "highlight");

    const res = await streamRequest(GAME_A_ID, "highlight", token);
    expect(res.status).toBe(200);
  });

  it("returns 401 after the token's TTL has elapsed", async () => {
    // Fake only Date so Date.now() is controllable while setTimeout/setInterval
    // (used internally by fetch and the HTTP server) remain real.
    vi.useFakeTimers({ toFake: ["Date"] });

    gameFinderMode.value = "game-a";
    const token = await mintToken(GAME_A_ID, "highlight");

    // Jump Date.now() past the 4-hour TTL.
    vi.setSystemTime(Date.now() + 4 * 60 * 60 * 1000 + 1);

    // fetch() still works because setTimeout is real.
    const res = await streamRequest(GAME_A_ID, "highlight", token);
    expect(res.status).toBe(401);

    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/expired|invalid/i);
  });

  it("returns 401 for a completely unknown token string", async () => {
    const res = await streamRequest(GAME_A_ID, "video", "not-a-real-token");
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Tests — cross-game token isolation
// ---------------------------------------------------------------------------

describe("GET /api/games/:gameId/stream/:type — token is scoped to its object path", () => {
  it("returns 401 when a non-existent token is used regardless of URL gameId", async () => {
    // Sanity: no token is valid without going through /stream-token first.
    const res = await streamRequest(GAME_B_ID, "video", "stolen-garbage-token");
    expect(res.status).toBe(401);
  });

  it("serves game A's objectPath (not game B's) when game A's token is used with game B's ID in the URL", async () => {
    /**
     * Scenario: An attacker steals game A's highlight token (PATH_A_HIGHLIGHT)
     * and substitutes game B's ID in the URL hoping to stream game B's content.
     *
     * Expected: The server ignores the URL's gameId after token validation and
     * uses the token's bound objectPath (PATH_A_HIGHLIGHT). Game B's video path
     * (PATH_B_VIDEO) is never accessed.
     *
     * This confirms the token is the sole authority on what content is served —
     * swapping the gameId in the URL cannot redirect the stream to a different
     * object than the one the token was issued for.
     */
    gameFinderMode.value = "game-a";
    const tokenForGameA = await mintToken(GAME_A_ID, "highlight");

    // Now issue the stream request with game B's ID but game A's token.
    // The server must use PATH_A_HIGHLIGHT (token-bound), not PATH_B_VIDEO.
    const res = await streamRequest(GAME_B_ID, "highlight", tokenForGameA);

    // The response must be 200 (token is still valid) …
    expect(res.status).toBe(200);

    // … and the server must have opened PATH_A_HIGHLIGHT, not PATH_B_VIDEO.
    // If PATH_B_VIDEO were served, the attacker gained access to another game's footage.
    expect(lastObjectPathRequested.value).toBe(PATH_A_HIGHLIGHT);
    expect(lastObjectPathRequested.value).not.toBe(PATH_B_VIDEO);
  });

  it("cannot use a token for game B's video to stream game A's highlight", async () => {
    /**
     * Mirror scenario: token minted for game B's video cannot serve
     * game A's highlight. The token is bound to PATH_B_VIDEO; hitting
     * /games/gameA/stream/highlight with it still serves PATH_B_VIDEO only.
     */
    gameFinderMode.value = "game-b";
    const tokenForGameB = await mintToken(GAME_B_ID, "video");

    lastObjectPathRequested.value = "";

    // Request game A's highlight using game B's video token.
    const res = await streamRequest(GAME_A_ID, "highlight", tokenForGameB);

    // Token is valid → 200, but content served must be game B's video path.
    expect(res.status).toBe(200);
    expect(lastObjectPathRequested.value).toBe(PATH_B_VIDEO);
    expect(lastObjectPathRequested.value).not.toBe(PATH_A_HIGHLIGHT);
  });

  it("returns 401 when an expired cross-game token is replayed", async () => {
    /**
     * Belt-and-suspenders: even if an attacker steals game A's token and
     * substitutes game B's ID, if the token has also expired they get 401.
     */
    vi.useFakeTimers({ toFake: ["Date"] });

    gameFinderMode.value = "game-a";
    const tokenForGameA = await mintToken(GAME_A_ID, "highlight");

    vi.setSystemTime(Date.now() + 4 * 60 * 60 * 1000 + 1);

    const res = await streamRequest(GAME_B_ID, "highlight", tokenForGameA);
    expect(res.status).toBe(401);

    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/expired|invalid/i);
  });
});
