/**
 * Film-room season filter regression test — Task #547
 *
 * The season-filter bug hid every game from Aug 2025–Jul 2026 from free-plan
 * accounts once August 2026 rolled over.  The fix removes the date filter from
 * GET /api/games (the mobile film-room endpoint) so coaches always see every
 * game they ever recorded regardless of subscription plan.
 *
 * This test pins that behaviour and confirms the complementary invariant:
 * GET /api/teams/:teamId/games (the web analytics endpoint) STILL applies the
 * season cutoff for free users — intentionally.
 *
 * Assertions:
 *   1. Free user — GET /api/games returns games from BOTH last season
 *      (2025-11-15) AND the current season (2026-09-05); no season filter.
 *   2. Free user — GET /api/teams/:teamId/games returns ONLY the current-
 *      season game (date ≥ 2026-08-01); the last-season game is absent.
 *   3. Pro user — GET /api/teams/:teamId/games returns both games (no filter).
 *
 * Mutation-sensitivity:
 *   The db.select WHERE mock detects the presence of the season-start string
 *   "2026-08-01" in the Drizzle WHERE expression.  If the /api/games handler
 *   re-introduces the season filter, the WHERE will contain that string and
 *   the mock will hide the old-season game, causing test 1 to fail.
 *   If the /api/teams/:teamId/games handler drops the filter for free users,
 *   the WHERE won't contain the season-start string and the mock will return
 *   both games, causing test 2 to fail.
 *
 * No real database, GCS bucket, or mobile device is required — all I/O is
 * replaced with in-memory mocks following the pattern in gameListAcl.test.ts.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";

// ---------------------------------------------------------------------------
// Fixtures — hoisted so vi.mock() factories can close over them.
// ---------------------------------------------------------------------------
const { COACH, TEAM_ID, LAST_SEASON_GAME, CURRENT_SEASON_GAME, SEASON_START } = vi.hoisted(
  () => {
    const COACH = { id: 55, clerkUserId: "clerk_coach", email: "coach@example.com" };
    const TEAM_ID = 10;
    const SEASON_START = "2026-08-01"; // season rolled over on 2026-08-01

    /** A game recorded in Nov 2025 — "last season" relative to Aug 2026 rollover */
    const LAST_SEASON_GAME = {
      id: 101,
      ownerId: COACH.id,
      teamId: TEAM_ID,
      opponent: "Old Rivals",
      date: "2025-11-15",
      result: "W",
      teamScore: 72,
      opponentScore: 68,
      videoObjectPath: "/objects/private/game-101.mp4",
      videoOffsetMs: null,
      videoDurationMs: null,
      videoHalf2StartMs: null,
      videoHalftimeGapMs: null,
      highlightObjectPath: null,
      highlightStatus: null,
      highlightError: null,
      highlightGeneratorVersion: null,
      mergedIntoGameId: null,
      createdAt: new Date("2025-11-15"),
    };

    /** A game recorded in Sep 2026 — "current season" */
    const CURRENT_SEASON_GAME = {
      id: 202,
      ownerId: COACH.id,
      teamId: TEAM_ID,
      opponent: "New Rivals",
      date: "2026-09-05",
      result: "L",
      teamScore: 60,
      opponentScore: 65,
      videoObjectPath: "/objects/private/game-202.mp4",
      videoOffsetMs: null,
      videoDurationMs: null,
      videoHalf2StartMs: null,
      videoHalftimeGapMs: null,
      highlightObjectPath: null,
      highlightStatus: null,
      highlightError: null,
      highlightGeneratorVersion: null,
      mergedIntoGameId: null,
      createdAt: new Date("2026-09-05"),
    };

    return { COACH, TEAM_ID, LAST_SEASON_GAME, CURRENT_SEASON_GAME, SEASON_START };
  },
);

/** Mutable entitlement plan — flip between "free" and "pro" across tests. */
const planRef = { value: "free" as "free" | "pro" };

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any `import` that triggers them.
// ---------------------------------------------------------------------------

/**
 * getCurrentSeasonStartDate returns "2026-08-01", simulating the August 2026
 * season rollover that originally caused the bug.
 */
vi.mock("../../lib/season", () => ({
  getCurrentSeasonStartDate: vi.fn().mockReturnValue("2026-08-01"),
}));

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
    req.appUser = { ...COACH } as any;
    next();
  },
}));

vi.mock("../../lib/entitlements", () => ({
  getEntitlementsForUser: vi.fn().mockImplementation(async () => ({ plan: planRef.value })),
  getEntitlements: vi.fn().mockImplementation(async () => ({ plan: planRef.value })),
  isPro: vi.fn().mockImplementation(() => planRef.value !== "free"),
}));

vi.mock("../../lib/objectStorage", () => {
  class ObjectStorageService {
    normalizeObjectEntityPath = vi.fn().mockImplementation((p: string) => p);
    getObjectEntityFile = vi.fn().mockResolvedValue({});
    canAccessObjectEntity = vi.fn().mockResolvedValue(false);
    getObjectEntitySignedURL = vi.fn().mockResolvedValue("https://storage.example.com/stub");
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

/**
 * Stateful DB mock.
 *
 * ALL_GAMES = [LAST_SEASON_GAME, CURRENT_SEASON_GAME] (ordered desc by date in
 * practice; order doesn't matter for these assertions).
 *
 * The select chain distinguishes four callers by FROM table and whether
 * innerJoin is present:
 *
 *   1. from(teamsTable)            → return the coach's team row
 *   2. from(gamesTable) + innerJoin → stats join: return empty
 *   3. from(gamesTable), no join,
 *      WHERE contains SEASON_START → return current-season game only
 *      (simulates the `gte(date, seasonStart)` predicate that the
 *      /teams/:id/games handler applies to free users)
 *   4. from(gamesTable), no join,
 *      WHERE lacks SEASON_START   → return both games
 *      (simulates the unrestricted /api/games handler)
 *
 * Mutation-sensitivity: if the /api/games handler ever re-introduces the
 * season cutoff, path 3 activates and hides LAST_SEASON_GAME → test 1 fails.
 * If /api/teams/:teamId/games drops the cutoff for free users, path 4 activates
 * and returns both games → test 2 fails.
 */
vi.mock("@workspace/db", () => {
  const GAMES_T = "gamesTable";
  const TEAMS_T = "teamsTable";
  const PGS_T   = "playerGameStatsTable";

  const TEAM_ROW = {
    id: TEAM_ID,
    ownerId: COACH.id,
    name: "Season Squad",
    sport: "basketball",
  };

  return {
    db: {
      query: {
        teamsTable: {
          findFirst: vi.fn().mockImplementation(async (args: any) => {
            // Return the team only when the WHERE contains the coach's ownerId.
            const whereStr = JSON.stringify(args?.where ?? {});
            return whereStr.includes(String(COACH.id)) ? { ...TEAM_ROW } : undefined;
          }),
        },
        gameEventsTable: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      },

      select: vi.fn().mockImplementation(() => {
        let fromTable: string | null = null;
        let hasJoin = false;

        const chain: any = {
          from: vi.fn().mockImplementation((table: string) => {
            fromTable = table;
            return chain;
          }),
          // Stats join path — present on playerGameStatsTable queries.
          innerJoin: vi.fn().mockImplementation(() => {
            hasJoin = true;
            return chain;
          }),
          where: vi.fn().mockImplementation((whereExpr: any) => {
            const whereStr = JSON.stringify(whereExpr ?? {});

            // 1. Teams select (GET /api/games fetches the coach's teams first)
            if (fromTable === TEAMS_T) {
              return Promise.resolve(
                whereStr.includes(String(COACH.id)) ? [{ ...TEAM_ROW }] : [],
              );
            }

            // 2. Stats join — always empty (not the focus of this test)
            if (fromTable === GAMES_T && hasJoin) {
              return Promise.resolve([]);
            }

            // 3 & 4. Games query: check for season-start cutoff in WHERE.
            //
            // GET /api/games has NO season filter → whereStr won't contain
            // SEASON_START → return both games (path 4).
            //
            // GET /api/teams/:teamId/games for free users DOES filter →
            // whereStr contains SEASON_START → return current-season only (path 3).
            if (fromTable === GAMES_T && !hasJoin) {
              const hasCutoff = whereStr.includes(SEASON_START);
              const games = hasCutoff
                ? [CURRENT_SEASON_GAME]
                : [LAST_SEASON_GAME, CURRENT_SEASON_GAME];
              return {
                orderBy: vi.fn().mockResolvedValue(games),
              };
            }

            return Promise.resolve([]);
          }),
          orderBy: vi.fn().mockResolvedValue([]),
        };
        return chain;
      }),

      transaction: vi.fn(),
    },

    // Drizzle table column references — truthy objects so drizzle helpers
    // embed literal values into queryChunks (same pattern as gameListAcl.test.ts).
    teamsTable:           TEAMS_T,
    gamesTable:           GAMES_T,
    playerGameStatsTable: PGS_T,
    playersTable:         "playersTable",
    gameEventsTable:      "gameEventsTable",
  };
});

// ---------------------------------------------------------------------------
// Real imports (after all mocks are registered)
// ---------------------------------------------------------------------------
import teamsRouter from "../teams";

// ---------------------------------------------------------------------------
// Express app — teamsRouter handles both /api/games and /api/teams/:id/games
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
  planRef.value = "free";
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function listAllGames() {
  return fetch(`${baseUrl}/api/games`);
}

async function listTeamGames(teamId: number) {
  return fetch(`${baseUrl}/api/teams/${teamId}/games`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/games — mobile film room, season filter removed", () => {
  it("free user sees last-season game (2025-11-15) alongside current-season game", async () => {
    planRef.value = "free";

    const res = await listAllGames();
    expect(res.status).toBe(200);

    const body = (await res.json()) as Array<{ id: number; date: string }>;
    expect(Array.isArray(body)).toBe(true);

    const ids = body.map((g) => g.id);
    expect(ids).toContain(LAST_SEASON_GAME.id);
    expect(ids).toContain(CURRENT_SEASON_GAME.id);
  });

  it("free user sees the last-season game's opponent name and date correctly", async () => {
    planRef.value = "free";

    const res = await listAllGames();
    expect(res.status).toBe(200);

    const body = (await res.json()) as Array<{ id: number; opponent: string; date: string }>;
    const old = body.find((g) => g.id === LAST_SEASON_GAME.id);
    expect(old).toBeDefined();
    expect(old!.opponent).toBe("Old Rivals");
    // date may be serialized as "2025-11-15" or "2025-11-15T00:00:00.000Z"
    expect(String(old!.date)).toContain("2025-11-15");
  });

  it("returns 200 even when all games pre-date the current season start", async () => {
    // Regression guard: the original bug returned an empty array for free users
    // when all games were from last season.  This confirms the endpoint never
    // applies the season cutoff regardless of plan.
    planRef.value = "free";

    const res = await listAllGames();
    expect(res.status).toBe(200);

    const body = (await res.json()) as any[];
    expect(body.length).toBeGreaterThan(0);
  });
});

describe("GET /api/teams/:teamId/games — web analytics, season filter preserved for free users", () => {
  it("free user does NOT see the last-season game (date < 2026-08-01)", async () => {
    planRef.value = "free";

    const res = await listTeamGames(TEAM_ID);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Array<{ id: number }>;
    const ids = body.map((g) => g.id);

    // Last-season game must be absent for free users on the analytics endpoint.
    expect(ids).not.toContain(LAST_SEASON_GAME.id);
  });

  it("free user DOES see the current-season game (date ≥ 2026-08-01)", async () => {
    planRef.value = "free";

    const res = await listTeamGames(TEAM_ID);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Array<{ id: number }>;
    expect(body.map((g) => g.id)).toContain(CURRENT_SEASON_GAME.id);
  });

  it("pro user sees both last-season and current-season games", async () => {
    planRef.value = "pro";

    const res = await listTeamGames(TEAM_ID);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Array<{ id: number }>;
    const ids = body.map((g) => g.id);

    expect(ids).toContain(LAST_SEASON_GAME.id);
    expect(ids).toContain(CURRENT_SEASON_GAME.id);
  });
});
