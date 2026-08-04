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

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
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

  const makeTx = () => ({
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
        if (table === PGS_T)   store.stats.length = 0;
        if (table === EVENTS_T) store.events.length = 0;
        return Promise.resolve(undefined);
      }),
    })),
    insert: vi.fn().mockImplementation((table: string) => ({
      values: vi.fn().mockImplementation((vals: any[]) => {
        if (table === PGS_T)   store.stats.push(...vals);
        if (table === EVENTS_T) store.events.push(...vals);
        return Promise.resolve(undefined);
      }),
    })),
  });

  const db = {
    query: {
      gamesTable: {
        findFirst: vi.fn().mockImplementation(async () =>
          store.games[0],
        ),
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
    const body = await res.json();
    expect(body.error).toMatch(/made.*cannot exceed.*attempted/i);
  });

  it("rejects twoMade > twoAttempted with 400", async () => {
    const res = await patchGame(10, buildPatchBody({ twoMade: 6, twoAttempted: 5 }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/made.*cannot exceed.*attempted/i);
  });

  it("rejects threeMade > threeAttempted with 400", async () => {
    const res = await patchGame(10, buildPatchBody({ threeMade: 4, threeAttempted: 3 }));
    expect(res.status).toBe(400);
    const body = await res.json();
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
    const game = await res.json();
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
