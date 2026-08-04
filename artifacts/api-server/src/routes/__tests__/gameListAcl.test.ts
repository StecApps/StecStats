/**
 * Games list ACL — cross-tenant isolation regression test
 *
 * Verifies that GET /api/teams/:teamId/games scopes by the requesting user's
 * ownerId, so Coach B cannot read Coach A's game list (including videoObjectPath
 * values) by guessing a team ID.
 *
 * Mutation-sensitivity: both the team ownership check and the games query mock
 * return data only when the Drizzle WHERE expression JSON-serializes to a
 * string that contains Coach A's ownerId value (101).  If either `findFirst`
 * or the games `db.select()` WHERE clause ever drops the ownerId predicate,
 * the mock returns nothing and the Coach A "200" test fails — surfacing the
 * regression immediately.
 *
 * Expected behaviour:
 *   - Coach A fetching their own team's games → 200 with game list.
 *   - Coach B fetching Coach A's team ID → 404 (team not found).
 *   - No videoObjectPath leaks into the 404 response body.
 *
 * No real GCS bucket, database, or camera access is required — all I/O
 * layers are replaced with in-memory mocks following the pattern in
 * gameVideoHijack.test.ts and gameReadAcl.test.ts.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";

// ---------------------------------------------------------------------------
// Fixtures — hoisted so vi.mock() factories can close over them.
// ---------------------------------------------------------------------------
const { COACH_A, COACH_B, COACH_A_TEAM_ID, COACH_A_GAME_ID, COACH_A_VIDEO_PATH } = vi.hoisted(
  () => {
    // Use distinctive IDs that cannot appear as substrings of each other,
    // avoiding false-positive matches when we search the WHERE JSON.
    const COACH_A = { id: 101, clerkUserId: "clerk_coach_a", email: "coach-a@example.com" };
    const COACH_B = { id: 202, clerkUserId: "clerk_coach_b", email: "coach-b@example.com" };
    const COACH_A_TEAM_ID = 401;
    const COACH_A_GAME_ID = 301;
    const COACH_A_VIDEO_PATH = "/objects/private/coach-a-game-video.mp4";
    return { COACH_A, COACH_B, COACH_A_TEAM_ID, COACH_A_GAME_ID, COACH_A_VIDEO_PATH };
  },
);

/** Mutable ref: set to the current requesting user before each fetch. */
const currentUser = { value: { id: 101, clerkUserId: "clerk_coach_a", email: "coach-a@example.com" } };

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any `import` that triggers them.
// ---------------------------------------------------------------------------

const COACH_A_TEAM_ROW = () => ({
  id: COACH_A_TEAM_ID,
  ownerId: COACH_A.id,
  name: "Test Squad",
});

const COACH_A_GAME_ROW = () => ({
  id: COACH_A_GAME_ID,
  ownerId: COACH_A.id,
  teamId: COACH_A_TEAM_ID,
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
  mergedIntoGameId: null,
  createdAt: new Date(),
});

vi.mock("@workspace/db", () => {
  return {
    db: {
      query: {
        /**
         * Mutation-sensitive findFirst: return Coach A's team only when the
         * Drizzle WHERE expression contains Coach A's ownerId (101).
         *
         * Drizzle SQL expressions produced by `eq()` and `and()` are
         * JSON-serializable; the literal value passed to `eq(col, value)`
         * appears directly in `queryChunks`.  If the production handler drops
         * `eq(teamsTable.ownerId, req.appUser.id)`, the serialized WHERE won't
         * contain 101, the mock returns undefined, and the Coach A "200" test
         * fails — surfacing the regression.
         */
        teamsTable: {
          findFirst: vi.fn().mockImplementation(async (args: any) => {
            const whereStr = JSON.stringify(args?.where ?? {});
            return whereStr.includes(String(COACH_A.id)) ? COACH_A_TEAM_ROW() : undefined;
          }),
        },
        gameEventsTable: {
          findMany: vi.fn().mockResolvedValue([]),
        },
        gamesTable: {
          findFirst: vi.fn().mockResolvedValue(undefined),
        },
        playersTable: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      },

      /**
       * db.select() is used for two queries in the list handler:
       *   1. Games list:  .from(gamesTable).where(...).orderBy(...)
       *   2. Stats join:  .from(playerGameStatsTable).innerJoin(...).where(...)
       *
       * We distinguish them by whether the `from()` call is followed by
       * `innerJoin` (stats) or `where().orderBy()` (games).
       *
       * For the games query, we apply the same mutation-sensitive pattern:
       * return game rows only when the WHERE clause contains COACH_A.id (101).
       */
      select: vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation(() => ({
          // Stats join path — always return empty (not the focus of this test).
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
          // Games list path — check ownerId presence in the WHERE expression.
          where: vi.fn().mockImplementation((whereExpr: any) => {
            const whereStr = JSON.stringify(whereExpr ?? {});
            const gamesForOwner = whereStr.includes(String(COACH_A.id))
              ? [COACH_A_GAME_ROW()]
              : [];
            return {
              orderBy: vi.fn().mockResolvedValue(gamesForOwner),
            };
          }),
        })),
      })),

      transaction: vi.fn(),
    },

    // Drizzle table column references — only need to be truthy objects so
    // that drizzle's eq() / and() helpers embed literal values into queryChunks.
    teamsTable: { id: "id", ownerId: "owner_id", name: "name" },
    gamesTable: {
      id: "id",
      ownerId: "owner_id",
      teamId: "team_id",
      videoObjectPath: "video_object_path",
      highlightObjectPath: "highlight_object_path",
      date: "date",
      mergedIntoGameId: "merged_into_game_id",
    },
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

vi.mock("../../lib/entitlements", () => ({
  getEntitlementsForUser: vi.fn().mockResolvedValue({ plan: "premium" }),
  getEntitlements: vi.fn().mockResolvedValue({ plan: "premium" }),
  isPro: vi.fn().mockReturnValue(true),
}));

vi.mock("../../lib/objectStorage", () => {
  class ObjectStorageService {
    getObjectEntityFile = vi.fn().mockResolvedValue({});
    normalizeObjectEntityPath = vi.fn().mockImplementation((p: string) => p);
    canAccessObjectEntity = vi.fn().mockResolvedValue(false);
    getObjectEntitySignedURL = vi
      .fn()
      .mockResolvedValue("https://storage.googleapis.com/signed-url-stub");
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

// ---------------------------------------------------------------------------
// Real imports (after mocks are registered)
// ---------------------------------------------------------------------------
import teamsRouter from "../teams";

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

  app.use("/api", teamsRouter);

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

async function listGames(teamId: number) {
  return fetch(`${baseUrl}/api/teams/${teamId}/games`);
}

// ---------------------------------------------------------------------------
// Tests — GET /api/teams/:teamId/games
// ---------------------------------------------------------------------------

describe("GET /api/teams/:teamId/games — cross-tenant read isolation", () => {
  it("returns 200 with game list including videoObjectPath for the team owner (Coach A)", async () => {
    // Coach A's ownerId (101) appears in the team findFirst WHERE and the
    // games select WHERE → both mocks return data → 200 with game list.
    currentUser.value = { ...COACH_A };

    const res = await listGames(COACH_A_TEAM_ID);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Array<{ id: number; videoObjectPath: string | null }>;
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);

    const game = body.find((g) => g.id === COACH_A_GAME_ID);
    expect(game).toBeDefined();
    expect(game!.videoObjectPath).toBe(COACH_A_VIDEO_PATH);
  });

  it("returns 404 when a different coach (Coach B) requests Coach A's team game list", async () => {
    // Coach B's ownerId (202) is in the WHERE clause instead of 101 →
    // teamsTable.findFirst returns undefined → handler returns 404 before
    // any game rows are fetched.  If the ownerId predicate is dropped,
    // the WHERE won't contain 101 either, causing the Coach A test to fail.
    currentUser.value = { ...COACH_B };

    const res = await listGames(COACH_A_TEAM_ID);
    expect(res.status).toBe(404);

    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTruthy();
    // Confirm no videoObjectPath value leaks into the error response.
    expect(JSON.stringify(body)).not.toContain(COACH_A_VIDEO_PATH);
  });
});
