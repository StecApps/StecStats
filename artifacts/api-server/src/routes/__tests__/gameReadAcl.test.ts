/**
 * Games read ACL — cross-tenant isolation regression test
 *
 * Verifies that GET /api/games/:gameId scopes by the requesting user's
 * ownerId via serializeGame(), so Coach B cannot read Coach A's game data
 * (including videoObjectPath) by guessing a game ID.
 *
 * Mutation-sensitivity: the DB mock returns Coach A's game row only when
 * the Drizzle WHERE expression JSON-serializes to a string that contains
 * Coach A's ownerId value.  If `serializeGame()` ever drops the
 * `eq(gamesTable.ownerId, ownerId)` predicate, the serialized WHERE will
 * no longer contain the ownerId, the mock returns undefined, and the
 * owner (Coach A) gets an unexpected 404 — causing the test to fail.
 *
 * Expected behaviour:
 *   - Coach A fetching their own game → 200 with full game data.
 *   - Coach B fetching Coach A's game ID → 404 (game not found).
 *   - No videoObjectPath leaks into the 404 response body.
 *
 * No real GCS bucket, database, or camera access is required — all I/O
 * layers are replaced with in-memory mocks following the pattern in
 * gameVideoHijack.test.ts.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";

// ---------------------------------------------------------------------------
// Fixtures — hoisted so vi.mock() factories can close over them.
// ---------------------------------------------------------------------------
const { COACH_A, COACH_B, COACH_A_GAME_ID, COACH_A_VIDEO_PATH } = vi.hoisted(() => {
  // Use distinctive IDs that cannot appear as substrings of each other,
  // avoiding false-positive matches when we search the WHERE JSON.
  const COACH_A = { id: 101, clerkUserId: "clerk_coach_a", email: "coach-a@example.com" };
  const COACH_B = { id: 202, clerkUserId: "clerk_coach_b", email: "coach-b@example.com" };
  const COACH_A_GAME_ID = 301;
  const COACH_A_VIDEO_PATH = "/objects/private/coach-a-game-video.mp4";
  return { COACH_A, COACH_B, COACH_A_GAME_ID, COACH_A_VIDEO_PATH };
});

/** Mutable ref: set to the current requesting user before each fetch. */
const currentUser = { value: { id: 101, clerkUserId: "clerk_coach_a", email: "coach-a@example.com" } };

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any `import` that triggers them.
// ---------------------------------------------------------------------------

/** Full game row for Coach A — returned by serializeGame's findFirst. */
const COACH_A_GAME_ROW = () => ({
  id: COACH_A_GAME_ID,
  ownerId: COACH_A.id,
  teamId: 401,
  opponent: "Rivals",
  date: "2024-01-15",
  result: "W",
  teamScore: 80,
  opponentScore: 70,
  videoObjectPath: COACH_A_VIDEO_PATH,
  videoOffsetMs: null,
  videoDurationMs: null,
  videoHalf2StartMs: null,
  videoHalftimeGapMs: null,
  highlightObjectPath: null,
  highlightStatus: null,
  highlightError: null,
  createdAt: new Date(),
});

vi.mock("@workspace/db", () => {
  return {
    db: {
      query: {
        gamesTable: {
          /**
           * Mutation-sensitive findFirst: return Coach A's game row only when
           * the Drizzle WHERE expression contains Coach A's ownerId value.
           *
           * Drizzle SQL expressions (produced by `eq()`, `and()`, etc.) are
           * JSON-serializable; the literal value passed to `eq(col, value)`
           * appears directly in `queryChunks`.  So if production code drops
           * `eq(gamesTable.ownerId, ownerId)` from the WHERE clause, the
           * serialized expression will no longer contain COACH_A.id (101),
           * and the mock returns undefined — causing the Coach A "200" test
           * to fail and surfacing the regression.
           */
          findFirst: vi.fn().mockImplementation(async (args: any) => {
            const whereStr = JSON.stringify(args?.where ?? {});
            // Return the row only when the WHERE clause is scoped to the
            // row's actual owner (ownerId = 101).  A query from Coach B
            // (ownerId = 202) or an unscoped query (no ownerId) gets nothing.
            return whereStr.includes(String(COACH_A.id)) ? COACH_A_GAME_ROW() : undefined;
          }),
        },
        teamsTable: {
          findFirst: vi.fn().mockResolvedValue({ id: 401, ownerId: COACH_A.id, name: "Test Squad" }),
        },
        playersTable: {
          findMany: vi.fn().mockResolvedValue([]),
        },
        gameEventsTable: {
          findMany: vi.fn().mockResolvedValue([]),
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
      // serializeGame uses db.select().from(playerGameStatsTable).innerJoin().where()
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
        }),
      }),
    },

    // Drizzle table column references — must be objects so drizzle SQL helpers
    // can walk them; primitive strings cause eq() to embed them verbatim in
    // queryChunks, which is exactly what we rely on for ownerId detection.
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
    },
    teamsTable: { id: "id", ownerId: "owner_id", name: "name" },
    playersTable: { id: "id", ownerId: "owner_id", name: "name" },
    playerGameStatsTable: {
      gameId: "game_id",
      playerId: "player_id",
      ftMade: "ft_made",
      ftAttempted: "ft_attempted",
      twoMade: "two_made",
      twoAttempted: "two_attempted",
      threeMade: "three_made",
      threeAttempted: "three_attempted",
      assists: "assists",
      rebounds: "rebounds",
      steals: "steals",
      turnovers: "turnovers",
      blocks: "blocks",
      goals: "goals",
      shots: "shots",
      shotsOffTarget: "shots_off_target",
      saves: "saves",
      yellowCards: "yellow_cards",
      redCards: "red_cards",
    },
    gameEventsTable: {
      gameId: "game_id",
      playerId: "player_id",
      statField: "stat_field",
      delta: "delta",
      videoTimestampMs: "video_timestamp_ms",
    },
  };
});

vi.mock("../../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock("../../middlewares/requireAuth", () => ({
  requireAuth: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    req.appUser = { ...currentUser.value } as any;
    next();
  },
}));

vi.mock("../../lib/objectStorage", () => {
  class ObjectStorageService {
    getObjectEntityFile = vi.fn().mockResolvedValue({});
    normalizeObjectEntityPath = vi.fn().mockImplementation((p: string) => p);
    canAccessObjectEntity = vi.fn().mockResolvedValue(false);
    getObjectEntitySignedURL = vi
      .fn()
      .mockResolvedValue("https://storage.googleapis.com/signed-url-stub");
    uploadLocalFileAsObjectEntity = vi.fn().mockResolvedValue("/objects/private/output.mp4");
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
    createWriteStream: vi.fn().mockReturnValue({ write: vi.fn(), end: vi.fn() }),
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
});

beforeEach(() => {
  currentUser.value = { ...COACH_A };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getGame(gameId: number) {
  return fetch(`${baseUrl}/api/games/${gameId}`);
}

// ---------------------------------------------------------------------------
// Tests — GET /api/games/:gameId
// ---------------------------------------------------------------------------

describe("GET /api/games/:gameId — cross-tenant read isolation", () => {
  it("returns 200 with game data including videoObjectPath for the owner (Coach A)", async () => {
    // Coach A's ownerId (101) appears in the WHERE clause → mock returns the row.
    currentUser.value = { ...COACH_A };

    const res = await getGame(COACH_A_GAME_ID);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { id: number; videoObjectPath: string | null };
    expect(body.id).toBe(COACH_A_GAME_ID);
    expect(body.videoObjectPath).toBe(COACH_A_VIDEO_PATH);
  });

  it("returns 404 when a different coach (Coach B) requests Coach A's game by ID", async () => {
    // Coach B's ownerId (202) appears in the WHERE clause instead of 101 → mock
    // returns undefined (no row with ownerId=202 exists) → route returns 404.
    // If production code drops the ownerId predicate, the WHERE JSON won't
    // contain 101 either — causing the Coach A test above to fail too,
    // making the regression immediately visible.
    currentUser.value = { ...COACH_B };

    const res = await getGame(COACH_A_GAME_ID);
    expect(res.status).toBe(404);

    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTruthy();
    // No videoObjectPath must leak into the error response.
    expect(JSON.stringify(body)).not.toContain(COACH_A_VIDEO_PATH);
  });
});
