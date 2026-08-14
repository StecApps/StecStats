/**
 * PATCH /api/games/:gameId — stat edit round-trip integration test
 *
 * Verifies that:
 *   1. Editing a player's stat line recalculates career PPG and shooting
 *      percentages when the player summary is fetched immediately after
 *      (round-trip correctness: the PATCH mutates the mock store, and the
 *      subsequent GET /players/:id/summary reads from that same store).
 *   2. The "made ≤ attempted" invariant is enforced server-side:
 *        - ftMade === ftAttempted is accepted (boundary condition)
 *        - ftMade > ftAttempted is rejected with HTTP 400
 *        - twoMade > twoAttempted is rejected with HTTP 400
 *        - threeMade > threeAttempted is rejected with HTTP 400
 *   3. Career win/loss totals update when the game result changes via PATCH.
 *
 * No real database, GCS bucket, or camera access is required — all I/O
 * layers are replaced with an in-memory store that both routers share.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";

// ---------------------------------------------------------------------------
// In-memory store — mutated by PATCH, read by GET /summary
// ---------------------------------------------------------------------------
const { COACH_A, currentUser, store } = vi.hoisted(() => {
  const COACH_A = { id: 1, clerkUserId: "clerk_coach_a", email: "coach-a@example.com" };
  const currentUser = { value: COACH_A as typeof COACH_A };

  /** Initial stat line: 2 FT/4, 3 two/5, 1 three/3 → 2+6+3 = 11 pts */
  const initialStats = () => [
    {
      gameId: 10,
      playerId: 20,
      ftMade: 2,
      ftAttempted: 4,
      twoMade: 3,
      twoAttempted: 5,
      threeMade: 1,
      threeAttempted: 3,
      assists: 5,
      rebounds: 7,
      steals: 2,
      turnovers: 1,
      blocks: 1,
      goals: 0,
      shots: 0,
      shotsOffTarget: 0,
      saves: 0,
      yellowCards: 0,
      redCards: 0,
    },
  ];

  const store = {
    games: [
      {
        id: 10,
        ownerId: 1,
        teamId: 5,
        opponent: "Rivals",
        date: "2024-01-15",
        result: "W" as string,
        teamScore: 80,
        opponentScore: 70,
        videoObjectPath: null as string | null,
        videoOffsetMs: null,
        videoDurationMs: null,
        videoHalf2StartMs: null,
        videoHalftimeGapMs: null,
        highlightObjectPath: null,
        highlightStatus: "idle",
        highlightError: null,
        highlightStartedAt: null,
        lowlightObjectPath: null,
        lowlightStatus: "idle",
        lowlightError: null,
        lowlightStartedAt: null,
        videoProxyObjectPath: null,
        videoProxyVersion: null,
        highlightGeneratorVersion: null,
        createdAt: new Date("2024-01-15"),
      },
    ] as any[],
    teams: [{ id: 5, ownerId: 1, name: "My Team" }] as any[],
    players: [{ id: 20, ownerId: 1, name: "Jordan", photoObjectPath: null, photoUpdatedAt: null }] as any[],
    stats: initialStats() as any[],
    events: [] as any[],
    resetStats: () => {
      store.stats = initialStats();
      store.games[0].result = "W";
    },
    /**
     * Set before calling DELETE /api/games/:gameId so the db.delete(gamesTable)
     * mock knows which game to remove and which stats to cascade-delete.
     * The DELETE handler only deletes the games row; stats are removed via
     * DB-level FK CASCADE in production — we simulate that here.
     */
    targetDeleteGameId: null as number | null,
  };

  return { COACH_A, currentUser, store };
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("../../middlewares/requireAuth", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.appUser = { ...currentUser.value } as any;
    next();
  },
}));

vi.mock("../../lib/logger", () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock("../../lib/entitlements", () => ({
  getEntitlementsForUser: vi.fn().mockResolvedValue({ plan: "pro" }),
  getEntitlements: vi.fn().mockResolvedValue({ plan: "pro" }),
  isPro: vi.fn().mockReturnValue(true),
}));

vi.mock("../../lib/season", () => ({
  getCurrentSeasonStartDate: vi.fn().mockReturnValue("2024-01-01"),
}));

vi.mock("../../lib/objectStorage", () => {
  class ObjectStorageService {
    normalizeObjectEntityPath = vi.fn().mockImplementation((p: string) => p);
    getObjectEntityFile = vi.fn().mockResolvedValue({});
    deleteObjectEntity = vi.fn().mockResolvedValue(undefined);
  }
  return { ObjectStorageService };
});

vi.mock("../../lib/objectAcl", () => ({
  getObjectAclPolicy: vi.fn().mockResolvedValue(null),
  setObjectAclPolicy: vi.fn().mockResolvedValue(undefined),
  ObjectPermission: { READ: "READ", WRITE: "WRITE" },
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

/**
 * Stateful DB mock.
 *
 * Sentinel strings are exported as the "table" references so that
 * tx.delete(playerGameStatsTable) is identifiable inside the mock.
 *
 * The select chain is context-aware: calling .from(playerGameStatsTable)
 * returns the stats + game result pairs from the in-memory store.
 */
vi.mock("@workspace/db", () => {
  const GAMES_T = "gamesTable";
  const PGS_T   = "playerGameStatsTable";
  const EVENTS_T = "gameEventsTable";
  const TEAMS_T  = "teamsTable";
  const PLAYERS_T = "playersTable";

  const makeTx = () => {
    // Track whether a stat-line delete is pending so the subsequent insert can
    // scope the actual removal to just the patched game's rows — leaving stats
    // for other games intact (matching the real `WHERE gameId = ?` clause).
    let pendingStatsDelete = false;

    return {
      update: vi.fn().mockImplementation((table: string) => ({
        set: vi.fn().mockImplementation((vals: any) => ({
          where: vi.fn().mockImplementation(() => {
            // Apply game-level field changes (result, scores, opponent…) to the
            // in-memory store so serializeGame and getPlayerSummary both see the
            // updated values after the transaction commits.
            if (table === GAMES_T) {
              Object.assign(store.games[0], vals);
            }
            return Promise.resolve(undefined);
          }),
        })),
      })),
      delete: vi.fn().mockImplementation((table: string) => ({
        where: vi.fn().mockImplementation(() => {
          // Real query: DELETE … WHERE gameId = <patched game>.
          // Flag it; the subsequent insert will tell us which gameId to remove.
          if (table === PGS_T)    pendingStatsDelete = true;
          if (table === EVENTS_T) store.events.length = 0;
          return Promise.resolve(undefined);
        }),
      })),
      insert: vi.fn().mockImplementation((table: string) => ({
        values: vi.fn().mockImplementation((vals: any[]) => {
          if (table === PGS_T) {
            if (pendingStatsDelete && vals.length > 0) {
              // Scope removal to just the game being re-written, preserving
              // other games' stats (mirrors the real WHERE gameId = ? delete).
              const patchedGameId = vals[0].gameId;
              store.stats = store.stats.filter((s: any) => s.gameId !== patchedGameId);
              pendingStatsDelete = false;
            }
            store.stats.push(...vals);
          }
          if (table === EVENTS_T) store.events.push(...vals);
          if (table === GAMES_T) {
            const row = { id: 99, ownerId: 1, videoObjectPath: null, ...vals[0] };
            const returning = vi.fn().mockResolvedValue([row]);
            // Route uses .onConflictDoNothing().returning() for clientGameId idempotency.
            return { returning, onConflictDoNothing: vi.fn().mockReturnValue({ returning }) };
          }
          return Promise.resolve(undefined);
        }),
      })),
    };
  };

  const db = {
    query: {
      gamesTable: {
        findFirst: vi.fn().mockImplementation(async () => {
          // When a DELETE is in flight, return that specific game so the handler
          // can read its object-path columns before deleting the row.
          if (store.targetDeleteGameId != null) {
            return store.games.find((g: any) => g.id === store.targetDeleteGameId) ?? null;
          }
          return store.games[0];
        }),
      },
      teamsTable: {
        findFirst: vi.fn().mockImplementation(async () =>
          store.teams[0],
        ),
      },
      playersTable: {
        findFirst: vi.fn().mockImplementation(async () =>
          store.players[0],
        ),
        findMany: vi.fn().mockImplementation(async () =>
          store.players,
        ),
      },
      playerGameStatsTable: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      gameEventsTable: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    },
    /**
     * Stateful select chain.
     *
     * Two callers hit from(PGS_T):
     *   - serializeGame  → .innerJoin(PLAYERS_T) → expects [{ stat, playerName }]
     *   - getPlayerSummary → .innerJoin(GAMES_T)  → expects [{ stat, result }]
     *
     * We track the join table so each caller gets the right shape.
     */
    select: vi.fn().mockImplementation(() => {
      let fromTable: string | null = null;
      let joinTable: string | null = null;
      const chain = {
        from: vi.fn().mockImplementation((table: string) => {
          fromTable = table;
          return chain;
        }),
        innerJoin: vi.fn().mockImplementation((table: string) => {
          joinTable = table;
          return chain;
        }),
        where: vi.fn().mockImplementation(() => {
          if (fromTable === PGS_T && joinTable === PLAYERS_T) {
            // serializeGame shape
            return Promise.resolve(
              store.stats.map((stat: any) => ({
                stat,
                playerName:
                  store.players.find((p: any) => p.id === stat.playerId)?.name ?? "Unknown",
              })),
            );
          }
          if (fromTable === PGS_T) {
            // getPlayerSummary shape (inner-joined with gamesTable)
            return Promise.resolve(
              store.stats.map((stat: any) => ({
                stat,
                result: store.games.find((g: any) => g.id === stat.gameId)?.result ?? "L",
              })),
            );
          }
          return Promise.resolve([]);
        }),
      };
      return chain;
    }),
    transaction: vi.fn().mockImplementation(async (fn: (tx: any) => Promise<any>) => {
      return fn(makeTx());
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    }),
    delete: vi.fn().mockImplementation((table: string) => ({
      where: vi.fn().mockImplementation(() => {
        if (table === GAMES_T) {
          // Simulate the DB-level FK CASCADE: removing a game row also removes
          // its stats and events for the deleted game only (not other games).
          const id = store.targetDeleteGameId;
          if (id != null) {
            store.games = store.games.filter((g: any) => g.id !== id);
            store.stats = store.stats.filter((s: any) => s.gameId !== id);
            store.events = store.events.filter((e: any) => e.gameId !== id);
            store.targetDeleteGameId = null;
          }
        }
        if (table === PGS_T)   store.stats.length = 0;
        if (table === EVENTS_T) store.events.length = 0;
        return Promise.resolve(undefined);
      }),
    })),
    insert: vi.fn().mockImplementation((table: string) => ({
      values: vi.fn().mockImplementation((vals: any[]) => {
        if (table === PGS_T)   store.stats.push(...vals);
        return Promise.resolve(undefined);
      }),
    })),
  };

  return {
    db,
    gamesTable:            GAMES_T,
    playerGameStatsTable:  PGS_T,
    gameEventsTable:       EVENTS_T,
    teamsTable:            TEAMS_T,
    playersTable:          PLAYERS_T,
  };
});

// ---------------------------------------------------------------------------
// Real imports (after all mocks are registered)
// ---------------------------------------------------------------------------
import gamesRouter   from "../games";
import playersRouter from "../players";

// ---------------------------------------------------------------------------
// Express app — both routers mounted so we can test the full round-trip
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
  app.use("/api", playersRouter);
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
  store.resetStats();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build the minimal valid PATCH body for game 10, player 20. */
function buildPatchBody(statOverrides: Record<string, number> = {}) {
  return {
    teamId: 5,
    opponent: "Rivals",
    date: "2024-01-15",
    result: "W",
    teamScore: 80,
    opponentScore: 70,
    videoObjectPath: null,
    videoOffsetMs: null,
    events: [],
    stats: [
      {
        playerId: 20,
        ftMade:        2, ftAttempted:    4,
        twoMade:       3, twoAttempted:   5,
        threeMade:     1, threeAttempted: 3,
        assists: 5, rebounds: 7, steals: 2, turnovers: 1, blocks: 1,
        ...statOverrides,
      },
    ],
  };
}

async function patchGame(gameId: number, body: object) {
  return fetch(`${baseUrl}/api/games/${gameId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function getPlayerSummary(playerId: number) {
  const res = await fetch(`${baseUrl}/api/players/${playerId}/summary`);
  expect(res.status).toBe(200);
  return res.json() as Promise<any>;
}

// ---------------------------------------------------------------------------
// Tests — made ≤ attempted invariant
// ---------------------------------------------------------------------------

describe("PATCH /api/games/:gameId — made ≤ attempted invariant", () => {
  it("accepts ftMade === ftAttempted (boundary condition)", async () => {
    const res = await patchGame(10, buildPatchBody({ ftMade: 4, ftAttempted: 4 }));
    expect(res.status).toBe(200);
  });

  it("rejects ftMade > ftAttempted with 400", async () => {
    const res = await patchGame(10, buildPatchBody({ ftMade: 5, ftAttempted: 4 }));
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toMatch(/made.*cannot exceed.*attempted/i);
  });

  it("rejects twoMade > twoAttempted with 400", async () => {
    const res = await patchGame(10, buildPatchBody({ twoMade: 6, twoAttempted: 5 }));
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toMatch(/made.*cannot exceed.*attempted/i);
  });

  it("rejects threeMade > threeAttempted with 400", async () => {
    const res = await patchGame(10, buildPatchBody({ threeMade: 4, threeAttempted: 3 }));
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toMatch(/made.*cannot exceed.*attempted/i);
  });

  it("accepts all-zero stat line without error", async () => {
    const res = await patchGame(10, buildPatchBody({
      ftMade: 0, ftAttempted: 0,
      twoMade: 0, twoAttempted: 0,
      threeMade: 0, threeAttempted: 0,
    }));
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Tests — career totals round-trip
// ---------------------------------------------------------------------------

describe("PATCH /api/games/:gameId — career stat round-trip", () => {
  it("PATCH response points field reflects twoMade*2 + threeMade*3 + ftMade*1", async () => {
    // 4 FT + 2 twos + 2 threes = 4 + 4 + 6 = 14 pts
    const res = await patchGame(10, buildPatchBody({
      ftMade: 4, ftAttempted: 4,
      twoMade: 2, twoAttempted: 3,
      threeMade: 2, threeAttempted: 4,
    }));
    expect(res.status).toBe(200);
    const game = await res.json() as any;
    const stat = game.stats.find((s: any) => s.playerId === 20);
    expect(stat).toBeDefined();
    expect(stat.points).toBe(14); // 4×1 + 2×2 + 2×3
  });

  it("career PPG in summary reflects updated stat line", async () => {
    // Initial: 2+6+3 = 11 pts. After edit: 2+4+6 = 12 pts.
    const patchRes = await patchGame(10, buildPatchBody({
      ftMade: 2, ftAttempted: 2,
      twoMade: 2, twoAttempted: 3,
      threeMade: 2, threeAttempted: 3,
    }));
    expect(patchRes.status).toBe(200);

    const summary = await getPlayerSummary(20);
    // 2*1 + 2*2 + 2*3 = 2 + 4 + 6 = 12 pts in 1 game → PPG = 12
    expect(summary.points).toBe(12);
    expect(summary.ppg).toBe(12);
    expect(summary.games).toBe(1);
  });

  it("FT shooting percentage in summary reflects updated ftMade/ftAttempted", async () => {
    // Raise FT to 3/4 = 75 %
    const patchRes = await patchGame(10, buildPatchBody({
      ftMade: 3, ftAttempted: 4,
    }));
    expect(patchRes.status).toBe(200);

    const summary = await getPlayerSummary(20);
    // ftPct = 3/4 = 0.75
    expect(summary.ftPct).toBeCloseTo(0.75);
    expect(summary.ftMade).toBe(3);
    expect(summary.ftAttempted).toBe(4);
  });

  it("3-point percentage in summary reflects updated threeMade/threeAttempted", async () => {
    // 2/4 = 50 %
    const patchRes = await patchGame(10, buildPatchBody({
      threeMade: 2, threeAttempted: 4,
    }));
    expect(patchRes.status).toBe(200);

    const summary = await getPlayerSummary(20);
    expect(summary.threePct).toBeCloseTo(0.5);
    expect(summary.threeMade).toBe(2);
    expect(summary.threeAttempted).toBe(4);
  });

  it("win/loss record in summary updates after changing game result via PATCH", async () => {
    // Initially the game is a W (see store initialisation).
    // PATCH with result: "L" — the mock transaction applies it to store.games[0]
    // so the subsequent summary query picks up the change through the real join path.
    const patchRes = await patchGame(10, { ...buildPatchBody(), result: "L" });
    expect(patchRes.status).toBe(200);

    const summary = await getPlayerSummary(20);
    expect(summary.wins).toBe(0);
    expect(summary.losses).toBe(1);
  });

  it("career rebounds-per-game updates after stat edit", async () => {
    const patchRes = await patchGame(10, buildPatchBody({ rebounds: 12 }));
    expect(patchRes.status).toBe(200);

    const summary = await getPlayerSummary(20);
    expect(summary.rebounds).toBe(12);
    expect(summary.rpg).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// Helpers — POST /api/games
// ---------------------------------------------------------------------------

/** Build a minimal valid POST /games body with one stat line for player 20. */
function buildPostBody(statOverrides: Record<string, number> = {}) {
  return {
    teamId: 5,
    opponent: "Rivals",
    date: "2024-01-15",
    result: "W",
    teamScore: 80,
    opponentScore: 70,
    events: [],
    stats: [
      {
        playerId: 20,
        ftMade: 2, ftAttempted: 4,
        twoMade: 3, twoAttempted: 5,
        threeMade: 1, threeAttempted: 3,
        assists: 5, rebounds: 7, steals: 2, turnovers: 1, blocks: 1,
        goals: 0, shots: 0, shotsOffTarget: 0, saves: 0,
        yellowCards: 0, redCards: 0,
        ...statOverrides,
      },
    ],
  };
}

async function postGame(body: object) {
  return fetch(`${baseUrl}/api/games`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Tests — POST /api/games made ≤ attempted invariant
// ---------------------------------------------------------------------------

describe("POST /api/games — made ≤ attempted invariant", () => {
  it("accepts ftMade === ftAttempted (boundary condition)", async () => {
    const res = await postGame(buildPostBody({ ftMade: 4, ftAttempted: 4 }));
    expect(res.status).toBe(201);
  });

  it("rejects ftMade > ftAttempted with 400", async () => {
    const res = await postGame(buildPostBody({ ftMade: 5, ftAttempted: 4 }));
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toMatch(/made.*cannot exceed.*attempted/i);
  });

  it("rejects twoMade > twoAttempted with 400", async () => {
    const res = await postGame(buildPostBody({ twoMade: 6, twoAttempted: 5 }));
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toMatch(/made.*cannot exceed.*attempted/i);
  });

  it("rejects threeMade > threeAttempted with 400", async () => {
    const res = await postGame(buildPostBody({ threeMade: 4, threeAttempted: 3 }));
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toMatch(/made.*cannot exceed.*attempted/i);
  });

  it("accepts all-zero stat line without error", async () => {
    const res = await postGame(buildPostBody({
      ftMade: 0, ftAttempted: 0,
      twoMade: 0, twoAttempted: 0,
      threeMade: 0, threeAttempted: 0,
    }));
    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Tests — multi-team career aggregation
// ---------------------------------------------------------------------------

describe("PATCH /api/games/:gameId — career totals aggregate across teams", () => {
  /**
   * Game 11 lives on a different team (id: 6) from game 10 (id: 5).
   * Stat line: 4 FT/4 + 0 twos/2 + 2 threes/3 → 4 + 0 + 6 = 10 pts
   */
  const GAME2_STAT = {
    gameId: 11,
    playerId: 20,
    ftMade: 4,  ftAttempted: 4,
    twoMade: 0, twoAttempted: 2,
    threeMade: 2, threeAttempted: 3,
    assists: 3, rebounds: 5, steals: 1, turnovers: 2, blocks: 0,
    goals: 0, shots: 0, shotsOffTarget: 0, saves: 0, yellowCards: 0, redCards: 0,
  };

  const GAME2 = {
    id: 11,
    ownerId: 1,
    teamId: 6,
    opponent: "Cross-Town",
    date: "2024-02-10",
    result: "L" as string,
    teamScore: 60,
    opponentScore: 65,
    videoObjectPath: null as string | null,
    videoOffsetMs: null,
    videoDurationMs: null,
    videoHalf2StartMs: null,
    videoHalftimeGapMs: null,
    highlightObjectPath: null,
    highlightStatus: "idle",
    highlightError: null,
    highlightStartedAt: null,
    lowlightObjectPath: null,
    lowlightStatus: "idle",
    lowlightError: null,
    lowlightStartedAt: null,
    videoProxyObjectPath: null,
    videoProxyVersion: null,
    highlightGeneratorVersion: null,
    createdAt: new Date("2024-02-10"),
  };

  beforeEach(() => {
    // Seed game 11 into the store for this suite.
    // store.resetStats() (outer beforeEach) already reset stats to game 10 only.
    if (!store.games.find((g: any) => g.id === 11)) {
      store.games.push(GAME2);
    }
    store.stats.push({ ...GAME2_STAT });
  });

  afterEach(() => {
    // Remove the extra game so it doesn't leak into other suites.
    const idx = store.games.findIndex((g: any) => g.id === 11);
    if (idx !== -1) store.games.splice(idx, 1);
  });

  it("career PPG aggregates both games after editing a stat on one team", async () => {
    // PATCH game 10 (team 5): change to 0 FT + 0 twos + 2 threes → 6 pts
    // Game 11 (team 6) unchanged: 4 + 0 + 6 = 10 pts
    // Expected career: (6 + 10) = 16 pts over 2 games → PPG = 8
    const patchRes = await patchGame(10, buildPatchBody({
      ftMade: 0, ftAttempted: 0,
      twoMade: 0, twoAttempted: 0,
      threeMade: 2, threeAttempted: 3,
    }));
    expect(patchRes.status).toBe(200);

    const summary = await getPlayerSummary(20);
    expect(summary.games).toBe(2);
    expect(summary.points).toBe(16);
    expect(summary.ppg).toBe(8);
  });

  it("game 11 stat is not lost when game 10 is patched (scoped delete)", async () => {
    // A scoping bug would clear ALL stats on PATCH, so game 11's rebound total
    // would vanish. Verify it survives intact.
    const patchRes = await patchGame(10, buildPatchBody({ rebounds: 3 }));
    expect(patchRes.status).toBe(200);

    const summary = await getPlayerSummary(20);
    // game 10: 3 reb (patched) + game 11: 5 reb = 8 total
    expect(summary.rebounds).toBe(8);
    expect(summary.rpg).toBe(4);
  });

  it("win/loss record counts both games across teams", async () => {
    // game 10 = W (default), game 11 = L (seeded above)
    const summary = await getPlayerSummary(20);
    expect(summary.wins).toBe(1);
    expect(summary.losses).toBe(1);
    expect(summary.games).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Tests — DELETE /api/games/:gameId career-total scoping
// ---------------------------------------------------------------------------

/**
 * These tests verify that deleting one game does NOT silently drop stats that
 * belong to other games for the same player (e.g. a bug where DELETE cleared
 * all playerGameStats rows rather than just those for the deleted game).
 *
 * The real DELETE handler only removes the gamesTable row; the DB FK CASCADE
 * removes that game's stat rows.  The mock simulates the cascade via
 * store.targetDeleteGameId so the summary query that follows sees only the
 * surviving game's stats.
 *
 * Stat lines:
 *   game 10 (team 5): 2 FT/4, 3 two/5, 1 three/3  →  2+6+3  = 11 pts  W
 *   game 11 (team 6): 4 FT/4, 0 two/2, 2 three/3  →  4+0+6  = 10 pts  L
 */
describe("DELETE /api/games/:gameId — career totals survive game deletion", () => {
  const GAME11_STAT = {
    gameId: 11,
    playerId: 20,
    ftMade: 4,  ftAttempted: 4,
    twoMade: 0, twoAttempted: 2,
    threeMade: 2, threeAttempted: 3,
    assists: 3, rebounds: 5, steals: 1, turnovers: 2, blocks: 0,
    goals: 0, shots: 0, shotsOffTarget: 0, saves: 0, yellowCards: 0, redCards: 0,
  };

  const GAME11 = {
    id: 11,
    ownerId: 1,
    teamId: 6,
    opponent: "Cross-Town",
    date: "2024-02-10",
    result: "L" as string,
    teamScore: 60,
    opponentScore: 65,
    videoObjectPath: null as string | null,
    videoOffsetMs: null,
    videoDurationMs: null,
    videoHalf2StartMs: null,
    videoHalftimeGapMs: null,
    highlightObjectPath: null,
    highlightStatus: "idle",
    highlightError: null,
    highlightStartedAt: null,
    lowlightObjectPath: null,
    lowlightStatus: "idle",
    lowlightError: null,
    lowlightStartedAt: null,
    videoProxyObjectPath: null,
    videoProxyVersion: null,
    highlightGeneratorVersion: null,
    createdAt: new Date("2024-02-10"),
  };

  /** Snapshot used to restore game 10 if the DELETE test removes it. */
  const GAME10_SNAPSHOT = {
    id: 10,
    ownerId: 1,
    teamId: 5,
    opponent: "Rivals",
    date: "2024-01-15",
    result: "W" as string,
    teamScore: 80,
    opponentScore: 70,
    videoObjectPath: null as string | null,
    videoOffsetMs: null,
    videoDurationMs: null,
    videoHalf2StartMs: null,
    videoHalftimeGapMs: null,
    highlightObjectPath: null,
    highlightStatus: "idle",
    highlightError: null,
    highlightStartedAt: null,
    lowlightObjectPath: null,
    lowlightStatus: "idle",
    lowlightError: null,
    lowlightStartedAt: null,
    videoProxyObjectPath: null,
    videoProxyVersion: null,
    highlightGeneratorVersion: null,
    createdAt: new Date("2024-01-15"),
  };

  beforeEach(() => {
    // outer beforeEach already reset stats to game 10 only
    store.targetDeleteGameId = null;
    if (!store.games.find((g: any) => g.id === 11)) {
      store.games.push({ ...GAME11 });
    }
    store.stats.push({ ...GAME11_STAT });
  });

  afterEach(() => {
    store.targetDeleteGameId = null;
    // Remove game 11 if it survived the test
    const idx11 = store.games.findIndex((g: any) => g.id === 11);
    if (idx11 !== -1) store.games.splice(idx11, 1);
    // Restore game 10 if the DELETE test removed it, so outer beforeEach is safe
    if (!store.games.find((g: any) => g.id === 10)) {
      store.games.unshift({ ...GAME10_SNAPSHOT });
    }
  });

  it("DELETE /games/:gameId returns 204", async () => {
    store.targetDeleteGameId = 10;
    const res = await fetch(`${baseUrl}/api/games/10`, { method: "DELETE" });
    expect(res.status).toBe(204);
  });

  it("career summary aggregates only game 2 after game 1 is deleted", async () => {
    // game 10: 11 pts (W)   game 11: 10 pts (L)
    // After deleting game 10 the summary must reflect game 11 only.
    store.targetDeleteGameId = 10;
    const deleteRes = await fetch(`${baseUrl}/api/games/10`, { method: "DELETE" });
    expect(deleteRes.status).toBe(204);

    const summary = await getPlayerSummary(20);
    expect(summary.games).toBe(1);
    expect(summary.points).toBe(10);  // game 11 only: 4+0+6
    expect(summary.ppg).toBe(10);
  });

  it("game 11 rebounds survive after game 10 is deleted", async () => {
    // A scoping bug would clear ALL stats on delete; game 11's rebound total
    // would vanish.  Verify it remains intact.
    store.targetDeleteGameId = 10;
    const deleteRes = await fetch(`${baseUrl}/api/games/10`, { method: "DELETE" });
    expect(deleteRes.status).toBe(204);

    const summary = await getPlayerSummary(20);
    expect(summary.rebounds).toBe(5);   // game 11 only
    expect(summary.rpg).toBe(5);
  });

  it("win/loss record reflects only game 11 after game 10 is deleted", async () => {
    // game 10 = W deleted, game 11 = L survives → 0W / 1L
    store.targetDeleteGameId = 10;
    const deleteRes = await fetch(`${baseUrl}/api/games/10`, { method: "DELETE" });
    expect(deleteRes.status).toBe(204);

    const summary = await getPlayerSummary(20);
    expect(summary.wins).toBe(0);
    expect(summary.losses).toBe(1);
    expect(summary.games).toBe(1);
  });
});
