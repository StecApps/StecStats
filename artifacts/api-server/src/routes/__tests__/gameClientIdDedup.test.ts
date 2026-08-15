/**
 * POST /api/games — clientId idempotency (offline-sync deduplication)
 *
 * Confirms that the offline-queue sync path cannot create duplicate games:
 *
 *   1. Happy path — a game POSTed with a clientId is created and returned (201).
 *   2. Idempotent replay — POSTing the same clientId a second time returns the
 *      SAME game id (201) instead of inserting a duplicate.  This models the
 *      real-world scenario where the network drops after the server committed the
 *      row but before the client received the 201 ACK, so the offline queue
 *      re-sends the same payload on reconnect.
 *   3. No clientId — the endpoint still works normally (no conflict path).
 *
 * All I/O (DB, object storage, entitlements) is mocked.  The test imports the
 * real production router so any change to the conflict/dedup logic in games.ts
 * breaks these tests immediately.
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
  TEAM_ROW,
  GAME_ROW,
  currentUser,
  teamFindFirstMock,
  playersFindManyMock,
  gameFindFirstMock,
  eventsFindManyMock,
  transactionMock,
  normalizePathMock,
} = vi.hoisted(() => {
  const COACH = { id: 10, clerkUserId: "clerk_coach", email: "coach@example.com" };

  const TEAM_ROW = {
    id: 1,
    ownerId: COACH.id,
    name: "Test Squad",
    sport: "basketball",
  };

  const GAME_ROW = {
    id: 42,
    ownerId: COACH.id,
    teamId: 1,
    opponent: "Rivals",
    date: "2026-08-14",
    result: "W",
    teamScore: 80,
    opponentScore: 70,
    videoObjectPath: null,
    videoOffsetMs: null,
    videoDurationMs: null,
    videoHalf2StartMs: null,
    videoHalftimeGapMs: null,
    highlightObjectPath: null,
    highlightStatus: null,
    highlightError: null,
    clientGameId: "test-client-id-abc123",
    createdAt: new Date("2026-08-14T00:00:00Z"),
  };

  const currentUser = { value: COACH as typeof COACH };

  const teamFindFirstMock = vi.fn();
  const playersFindManyMock = vi.fn();
  const gameFindFirstMock = vi.fn();
  const eventsFindManyMock = vi.fn();
  const transactionMock = vi.fn();
  const normalizePathMock = vi.fn().mockImplementation((p: string) => p);

  return {
    COACH,
    TEAM_ROW,
    GAME_ROW,
    currentUser,
    teamFindFirstMock,
    playersFindManyMock,
    gameFindFirstMock,
    eventsFindManyMock,
    transactionMock,
    normalizePathMock,
  };
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
  getEntitlementsForUser: vi.fn().mockResolvedValue([]),
  getEntitlements: vi.fn().mockResolvedValue([]),
  isPro: vi.fn().mockReturnValue(false),
}));

vi.mock("../../lib/stats", () => ({
  computePoints: vi.fn().mockReturnValue(0),
}));

vi.mock("../../lib/videoDuration", () => ({
  scheduleVideoDurationProbe: vi.fn(),
}));

vi.mock("../../lib/highlightGenerator", () => ({
  PROXY_VERSION: "v5",
  PROXY_CHUNK_DURATION_SEC: 30,
  makeProxyChunkGcsPath: vi.fn(),
  getReadyProxyChunkCount: vi.fn().mockResolvedValue(0),
  readHlsSentinel: vi.fn().mockResolvedValue(null),
  acquireProxyChunkLocally: vi.fn().mockResolvedValue(null),
  ensureAllProxyChunksInBackground: vi.fn(),
  ensureGameProxyInBackground: vi.fn(),
  cancelHighlightGeneration: vi.fn(),
  cancelProxyBuild: vi.fn(),
}));

vi.mock("../../lib/objectStorage", () => {
  class ObjectStorageService {
    normalizeObjectEntityPath = normalizePathMock;
    getObjectEntityFile = vi.fn().mockRejectedValue(new Error("not found"));
    deleteObjectEntity = vi.fn().mockResolvedValue(undefined);
    canAccessObjectEntity = vi.fn().mockResolvedValue(false);
    getObjectEntitySignedURL = vi.fn().mockResolvedValue("https://example.com/signed");
  }
  class ObjectNotFoundError extends Error {
    constructor(msg = "Not found") { super(msg); this.name = "ObjectNotFoundError"; }
  }
  return { ObjectStorageService, ObjectNotFoundError };
});

vi.mock("../../lib/objectAcl", () => ({
  ObjectPermission: { READ: "READ", WRITE: "WRITE" },
  canAccessObject: vi.fn().mockResolvedValue(false),
  getObjectAclPolicy: vi.fn().mockResolvedValue(null),
  setObjectAclPolicy: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@workspace/db", () => {
  // Chainable select mock for serializeGame's stat-join query
  const selectMock = vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
  });

  return {
    db: {
      transaction: transactionMock,
      query: {
        teamsTable: { findFirst: teamFindFirstMock },
        playersTable: { findMany: playersFindManyMock },
        gamesTable: { findFirst: gameFindFirstMock },
        gameEventsTable: { findMany: eventsFindManyMock },
      },
      select: selectMock,
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      }),
    },
    gamesTable: {
      id: "id", ownerId: "owner_id", teamId: "team_id",
      clientGameId: "client_game_id", opponent: "opponent",
      videoObjectPath: "video_object_path",
      highlightObjectPath: "highlight_object_path",
      lowlightObjectPath: "lowlight_object_path",
      videoProxyObjectPath: "video_proxy_object_path",
      highlightStatus: "highlight_status",
    },
    playerGameStatsTable: { gameId: "game_id", playerId: "player_id" },
    gameEventsTable: { gameId: "game_id" },
    teamsTable: { id: "id", ownerId: "owner_id" },
    playersTable: { id: "id", ownerId: "owner_id" },
    usersTable: { id: "id" },
  };
});

// ---------------------------------------------------------------------------
// Real router import (after mocks are registered)
// ---------------------------------------------------------------------------
import gamesRouter from "../games";

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
  app.use("/api", gamesRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTx(scenario: "fresh" | "replay") {
  const statsInsert = vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
  const eventsInsert = vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });

  // The main gamesTable insert: returns the new row on fresh, nothing on replay (conflict)
  const gamesInsert = vi.fn().mockReturnValue({
    values: vi.fn().mockReturnValue({
      onConflictDoNothing: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(scenario === "fresh" ? [{ ...GAME_ROW }] : []),
      }),
    }),
  });

  const txFindFirst = vi.fn().mockResolvedValue(
    scenario === "replay" ? { ...GAME_ROW } : undefined,
  );

  return {
    insert: vi.fn().mockImplementation(() => gamesInsert()),
    query: { gamesTable: { findFirst: txFindFirst } },
  };
}

const VALID_BODY = {
  teamId: 1,
  opponent: "Rivals",
  date: "2026-08-14",
  result: "W",
  teamScore: 80,
  opponentScore: 70,
  stats: [],
  events: [],
};

function postGame(body: object) {
  return fetch(`${baseUrl}/api/games`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Default: team exists, no players to validate, game row exists for serializeGame
  teamFindFirstMock.mockResolvedValue({ ...TEAM_ROW });
  playersFindManyMock.mockResolvedValue([]);
  gameFindFirstMock.mockResolvedValue({ ...GAME_ROW });
  eventsFindManyMock.mockResolvedValue([]);
});

describe("POST /api/games — clientId offline-sync deduplication", () => {
  it("happy path: creates a game and returns 201 with the game id", async () => {
    transactionMock.mockImplementation(async (cb: any) => cb(makeTx("fresh")));

    const res = await postGame({ ...VALID_BODY, clientId: "unique-client-id-001" });

    expect(res.status).toBe(201);
    const body = await res.json() as { id: number };
    expect(body).toHaveProperty("id", GAME_ROW.id);
  });

  it("idempotent replay: second POST with same clientId returns the same game id — no duplicate", async () => {
    // First call: insert succeeds
    transactionMock.mockImplementationOnce(async (cb: any) => cb(makeTx("fresh")));
    const first = await postGame({ ...VALID_BODY, clientId: "stable-client-id-xyz" });
    expect(first.status).toBe(201);
    const firstBody = await first.json() as { id: number };

    // Second call: ON CONFLICT DO NOTHING → tx finds the existing row
    transactionMock.mockImplementationOnce(async (cb: any) => cb(makeTx("replay")));
    const second = await postGame({ ...VALID_BODY, clientId: "stable-client-id-xyz" });
    expect(second.status).toBe(201);
    const secondBody = await second.json() as { id: number };

    // Must return the same game — not a new one
    expect(secondBody.id).toBe(firstBody.id);
  });

  it("idempotent replay: returns 201 (not 409) so the client removes the game from its queue", async () => {
    transactionMock.mockImplementation(async (cb: any) => cb(makeTx("replay")));

    const res = await postGame({ ...VALID_BODY, clientId: "replay-id-should-not-be-409" });

    // A 409 would leave the game in the offline queue forever; 201 lets the
    // client call removeQueuedGame() and move on.
    expect(res.status).toBe(201);
  });

  it("works normally without a clientId (no conflict path involved)", async () => {
    transactionMock.mockImplementation(async (cb: any) => cb(makeTx("fresh")));

    const res = await postGame(VALID_BODY); // no clientId field
    expect(res.status).toBe(201);
    const body = await res.json() as { id: number };
    expect(body).toHaveProperty("id");
  });

  it("returns 404 when the team does not belong to the requesting coach", async () => {
    teamFindFirstMock.mockResolvedValueOnce(undefined);

    const res = await postGame({ ...VALID_BODY, clientId: "no-team-id" });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/team/i);
  });
});
