/**
 * Cross-tenant video hijack protection — regression test
 *
 * Verifies that claimVideoObjectPath() in the POST /api/games and
 * PATCH /api/games/:id routes prevents one coach (Coach B) from
 * referencing an object-storage path that is already linked to another
 * coach (Coach A), whether the link is through:
 *
 *   (a) The DB: Coach A's game row already has videoObjectPath = PATH_A
 *       (covers "legacy objects with no ACL metadata yet").
 *   (b) The ACL metadata alone: the object's custom:aclPolicy metadata
 *       reports a different owner, but no game row exists for that path.
 *
 * Expected: both scenarios return HTTP 409 with an ownership-conflict error.
 * The owner themselves must still be able to reference their own object (201/200).
 *
 * No real GCS bucket, database, or camera access is required — all I/O layers
 * are replaced with in-memory mocks.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";

// ---------------------------------------------------------------------------
// Test fixtures — hoisted so vi.mock() factories can close over them.
// ---------------------------------------------------------------------------
const {
  COACH_A,
  COACH_B,
  /** The video object path that belongs to Coach A. */
  PATH_A,
  /**
   * Mutable ref for the user that requireAuth will inject into req.appUser.
   * Tests switch this before issuing a request.
   */
  currentUser,
  /**
   * Controls what db.query.gamesTable.findFirst returns.
   *
   * "coach-a-owns-path" — PATH_A is already linked to Coach A's game row.
   *   When Coach A is the requester, claimVideoObjectPath sees ownerId match
   *   and does NOT throw (owner can re-reference their own object).
   *   serializeGame also gets a valid row back → 201 for Coach A.
   *   When Coach B is the requester, ownerId mismatch → 409.
   *
   * "no-game"           — No DB linkage at all (ACL-only guard scenario).
   *
   * "coach-b-game"      — Coach B's own game (used for PATCH ownership check
   *                       via mockImplementationOnce, not this state directly).
   */
  gamesFinderState,
} = vi.hoisted(() => {
  const COACH_A = { id: 1, clerkUserId: "clerk_coach_a", email: "coach-a@example.com" };
  const COACH_B = { id: 2, clerkUserId: "clerk_coach_b", email: "coach-b@example.com" };
  const PATH_A = "/objects/private/coach-a-game-video.mp4";
  const currentUser = { value: COACH_A as typeof COACH_A };
  const gamesFinderState = {
    value: "no-game" as "coach-a-owns-path" | "no-game",
  };
  return { COACH_A, COACH_B, PATH_A, currentUser, gamesFinderState };
});

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any `import` that triggers them.
// ---------------------------------------------------------------------------

/** Full game row for Coach A — returned by findFirst in the "linked" state. */
const COACH_A_GAME_ROW = () => ({
  id: 10,
  ownerId: COACH_A.id,
  videoObjectPath: PATH_A,
  highlightObjectPath: null,
  teamId: 1,
  opponent: "Rivals",
  date: "2024-01-15",
  result: "W",
  teamScore: 80,
  opponentScore: 70,
  videoOffsetMs: null,
  videoDurationMs: null,
  videoHalf2StartMs: null,
  videoHalftimeGapMs: null,
  highlightStatus: null,
  highlightError: null,
  createdAt: new Date(),
});

/**
 * Coach A's game row where PATH_A is stored in highlightObjectPath, not
 * videoObjectPath.  Used to verify the DB-linkage guard covers both columns.
 */
const COACH_A_HIGHLIGHT_GAME_ROW = () => ({
  id: 11,
  ownerId: COACH_A.id,
  videoObjectPath: null,
  highlightObjectPath: PATH_A,
  teamId: 1,
  opponent: "Rivals",
  date: "2024-01-15",
  result: "W",
  teamScore: 80,
  opponentScore: 70,
  videoOffsetMs: null,
  videoDurationMs: null,
  videoHalf2StartMs: null,
  videoHalftimeGapMs: null,
  highlightStatus: null,
  highlightError: null,
  createdAt: new Date(),
});

/**
 * Coach A's game row where PATH_A is stored in lowlightObjectPath, not
 * videoObjectPath or highlightObjectPath.  Used to verify the DB-linkage
 * guard covers the lowlight column as well.
 */
const COACH_A_LOWLIGHT_GAME_ROW = () => ({
  id: 12,
  ownerId: COACH_A.id,
  videoObjectPath: null,
  highlightObjectPath: null,
  teamId: 1,
  opponent: "Rivals",
  date: "2024-01-15",
  result: "W",
  teamScore: 80,
  opponentScore: 70,
  videoOffsetMs: null,
  videoDurationMs: null,
  videoHalf2StartMs: null,
  videoHalftimeGapMs: null,
  highlightStatus: null,
  highlightError: null,
  createdAt: new Date(),
});

/** Full game row for Coach B — used in PATCH ownership checks. */
const COACH_B_GAME_ROW = () => ({
  id: 20,
  ownerId: COACH_B.id,
  videoObjectPath: null,
  highlightObjectPath: null,
  teamId: 1,
  opponent: "Other",
  date: "2024-02-01",
  result: "L",
  teamScore: 60,
  opponentScore: 75,
  videoOffsetMs: null,
  videoDurationMs: null,
  videoHalf2StartMs: null,
  videoHalftimeGapMs: null,
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
           * "coach-a-owns-path": PATH_A is linked to Coach A's game.
           *   - When Coach A is the requester, claimVideoObjectPath sees
           *     linked.ownerId === ownerId and does not throw → pass.
           *     serializeGame also receives a valid row → 201.
           *   - When Coach B is the requester, ownerId mismatch → 409.
           *
           * "no-game": no DB linkage exists; ACL metadata governs.
           *   serializeGame will get undefined and return null, which the
           *   route wraps in a 500. The happy-path tests always use
           *   "coach-a-owns-path" so serializeGame finds the row.
           */
          findFirst: vi.fn().mockImplementation(async () => {
            if (gamesFinderState.value === "coach-a-owns-path") {
              return COACH_A_GAME_ROW();
            }
            return undefined;
          }),
        },
        teamsTable: {
          // Always return a valid team so the team-ownership gate passes.
          findFirst: vi.fn().mockResolvedValue({
            id: 1,
            ownerId: 1,
            name: "Test Squad",
          }),
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
            values: vi.fn().mockReturnValue({
              returning: vi.fn().mockImplementation(async () => [
                {
                  ...COACH_A_GAME_ROW(),
                  id: currentUser.value.id === COACH_A.id ? 10 : 20,
                  ownerId: currentUser.value.id,
                },
              ]),
            }),
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

    // Drizzle table references — only need to be truthy objects.
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

/**
 * aclState controls what getObjectAclPolicy returns. Tests set this to
 * simulate a fresh object (null) or an already-claimed object.
 */
const { aclState } = vi.hoisted(() => {
  const aclState = {
    value: null as { owner: string; visibility: "private" | "public" } | null,
  };
  return { aclState };
});

vi.mock("../../lib/objectAcl", () => ({
  getObjectAclPolicy: vi.fn().mockImplementation(async () => aclState.value),
  setObjectAclPolicy: vi.fn().mockResolvedValue(undefined),
  ObjectPermission: { READ: "READ", WRITE: "WRITE" },
}));

vi.mock("../../lib/objectStorage", () => {
  const mockObjectFile = {
    exists: vi.fn().mockResolvedValue([true]),
    getMetadata: vi.fn().mockResolvedValue([{ contentType: "video/mp4", size: 5_000_000 }]),
    setMetadata: vi.fn().mockResolvedValue(undefined),
  };

  class ObjectStorageService {
    getObjectEntityFile = vi.fn().mockResolvedValue(mockObjectFile);
    // normalizeObjectEntityPath must be a pass-through so PATH_A survives intact.
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

// All users are Pro so the video-feature entitlement gate never fires.
vi.mock("../../lib/entitlements", () => ({
  getEntitlementsForUser: vi.fn().mockResolvedValue({ plan: "premium" }),
  getEntitlements: vi.fn().mockResolvedValue({ plan: "premium" }),
  isPro: vi.fn().mockReturnValue(true),
}));

// videoDuration probe is fire-and-forget — suppress it.
vi.mock("../../lib/videoDuration", () => ({
  scheduleVideoDurationProbe: vi.fn(),
}));

// highlightGenerator — not exercised here; suppress side-effects.
vi.mock("../../lib/highlightGenerator", () => ({
  PROXY_VERSION: 1,
  ensureGameProxyInBackground: vi.fn(),
}));

// child_process — games.ts imports execFile/spawn for video repair; not hit
// in these tests but must be importable without spawning real processes.
vi.mock("child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

// fs — games.ts imports fs for video-repair paths; stub so no real I/O occurs.
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

  // Inject a silent req.log stub (pino-http in production).
  app.use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as any).log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
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

// Reset to safe defaults before every test.
beforeEach(() => {
  currentUser.value = COACH_A;
  gamesFinderState.value = "no-game";
  aclState.value = null;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid CreateGameBody — no stats, no events. */
const baseGameBody = () => ({
  teamId: 1,
  opponent: "Rivals",
  date: "2024-01-15",
  result: "W",
  teamScore: 80,
  opponentScore: 70,
  stats: [],
  events: [],
});

async function postGame(body: object) {
  return fetch(`${baseUrl}/api/games`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function patchGame(gameId: number, body: object) {
  return fetch(`${baseUrl}/api/games/${gameId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Tests — POST /api/games
// ---------------------------------------------------------------------------

describe("POST /api/games — cross-tenant video hijack guard", () => {
  it("returns 409 when Coach B references an object DB-linked to Coach A (legacy: no ACL)", async () => {
    /**
     * PATH_A is already recorded in Coach A's game row (DB linkage).
     * No ACL metadata exists yet (legacy object uploaded before ACL was added).
     * Coach B must be blocked by the DB-ownership check in claimVideoObjectPath.
     */
    currentUser.value = COACH_B;
    gamesFinderState.value = "coach-a-owns-path"; // DB already links PATH_A to Coach A
    aclState.value = null;                         // No ACL metadata (legacy object)

    const res = await postGame({ ...baseGameBody(), videoObjectPath: PATH_A });
    expect(res.status).toBe(409);

    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/already owned/i);
  });

  it("returns 409 when Coach B references an object whose ACL names Coach A (no DB linkage)", async () => {
    /**
     * PATH_A has no game row yet (e.g. uploaded but not saved to any game),
     * but its ACL metadata already names Coach A as the owner.
     * Coach B must be blocked by the ACL-policy check in claimVideoObjectPath.
     */
    currentUser.value = COACH_B;
    gamesFinderState.value = "no-game";                               // No DB linkage
    aclState.value = { owner: String(COACH_A.id), visibility: "private" }; // ACL: Coach A

    const res = await postGame({ ...baseGameBody(), videoObjectPath: PATH_A });
    expect(res.status).toBe(409);

    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/already owned/i);
  });

  it("returns 201 when Coach A creates a game referencing their own fresh upload (no prior ACL)", async () => {
    /**
     * Happy path: PATH_A is linked to Coach A's game row and has no ACL yet
     * (fresh upload). claimVideoObjectPath sees linked.ownerId === ownerId
     * and passes rather than throwing. The route proceeds to 201.
     *
     * Note: gamesFinderState "coach-a-owns-path" also satisfies serializeGame
     * (it finds the game row via the same findFirst mock).
     */
    currentUser.value = COACH_A;
    gamesFinderState.value = "coach-a-owns-path"; // Coach A's own row — no ownerId mismatch
    aclState.value = null;                         // Fresh upload, no ACL yet

    const res = await postGame({ ...baseGameBody(), videoObjectPath: PATH_A });
    expect(res.status).toBe(201);
  });

  it("returns 201 when Coach A creates a game referencing a path they already own per ACL", async () => {
    /**
     * Coach A re-references their own already-claimed object.
     * ACL says owner = Coach A; claimVideoObjectPath must pass, not reject.
     */
    currentUser.value = COACH_A;
    gamesFinderState.value = "coach-a-owns-path";
    aclState.value = { owner: String(COACH_A.id), visibility: "private" };

    const res = await postGame({ ...baseGameBody(), videoObjectPath: PATH_A });
    expect(res.status).toBe(201);
  });

  it("returns 409 when Coach B references a path already in Coach A's highlightObjectPath (DB linkage via highlight column)", async () => {
    /**
     * PATH_A appears in Coach A's highlightObjectPath, not videoObjectPath.
     * claimVideoObjectPath checks both columns via Promise.all; the second
     * branch (highlightObjectPath) must still trigger the 409.
     *
     * Mock layout:
     *   call 1 — videoObjectPath check  → undefined (no row has PATH_A as video)
     *   call 2 — highlightObjectPath check → COACH_A_HIGHLIGHT_GAME_ROW
     */
    currentUser.value = COACH_B;
    aclState.value = null; // No ACL metadata; guard must fire via DB

    const { db } = await import("@workspace/db");
    (vi.mocked(db.query.gamesTable.findFirst) as any)
      .mockImplementationOnce(async () => undefined)                   // videoObjectPath: no match
      .mockImplementation(async () => COACH_A_HIGHLIGHT_GAME_ROW());  // highlightObjectPath: Coach A

    const res = await postGame({ ...baseGameBody(), videoObjectPath: PATH_A });
    expect(res.status).toBe(409);

    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/already owned/i);

    // Restore the default state-based implementation for subsequent tests.
    (vi.mocked(db.query.gamesTable.findFirst) as any).mockImplementation(async () => {
      if (gamesFinderState.value === "coach-a-owns-path") return COACH_A_GAME_ROW();
      return undefined;
    });
  });

  it("returns 409 when Coach B references a path already in Coach A's lowlightObjectPath (DB linkage via lowlight column)", async () => {
    /**
     * PATH_A appears in Coach A's lowlightObjectPath, not videoObjectPath or
     * highlightObjectPath.  claimVideoObjectPath checks all three columns via
     * Promise.all; the third branch (lowlightObjectPath) must still trigger
     * the 409.
     *
     * Mock layout:
     *   call 1 — videoObjectPath check    → undefined (no match)
     *   call 2 — highlightObjectPath check → undefined (no match)
     *   call 3 — lowlightObjectPath check  → COACH_A_LOWLIGHT_GAME_ROW
     */
    currentUser.value = COACH_B;
    aclState.value = null; // No ACL metadata; guard must fire via DB

    const { db } = await import("@workspace/db");
    (vi.mocked(db.query.gamesTable.findFirst) as any)
      .mockImplementationOnce(async () => undefined)                   // videoObjectPath: no match
      .mockImplementationOnce(async () => undefined)                   // highlightObjectPath: no match
      .mockImplementation(async () => COACH_A_LOWLIGHT_GAME_ROW());   // lowlightObjectPath: Coach A

    const res = await postGame({ ...baseGameBody(), videoObjectPath: PATH_A });
    expect(res.status).toBe(409);

    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/already owned/i);

    // Restore the default state-based implementation for subsequent tests.
    (vi.mocked(db.query.gamesTable.findFirst) as any).mockImplementation(async () => {
      if (gamesFinderState.value === "coach-a-owns-path") return COACH_A_GAME_ROW();
      return undefined;
    });
  });
});

// ---------------------------------------------------------------------------
// Tests — PATCH /api/games/:id
// ---------------------------------------------------------------------------

describe("PATCH /api/games/:id — cross-tenant video hijack guard", () => {
  it("returns 409 when Coach B patches their own game to reference a path DB-linked to Coach A (legacy: no ACL)", async () => {
    /**
     * Coach B owns game 20. They attempt to set its videoObjectPath to
     * PATH_A, which is already linked to Coach A in the DB (legacy: no ACL).
     *
     * The PATCH handler calls gamesTable.findFirst twice before reaching
     * claimVideoObjectPath:
     *   call 1: ownership check for game 20 → must return Coach B's game.
     *   calls 2+3 (inside claimVideoObjectPath): PATH_A's DB linkage check
     *             → must return Coach A's game to trigger the 409.
     *
     * We use mockImplementationOnce to give call 1 a different result.
     */
    currentUser.value = COACH_B;
    aclState.value = null;

    const { db } = await import("@workspace/db");
    (vi.mocked(db.query.gamesTable.findFirst) as any)
      .mockImplementationOnce(async () => COACH_B_GAME_ROW())   // call 1: Coach B owns game 20
      .mockImplementation(async () => COACH_A_GAME_ROW());       // calls 2+3: PATH_A → Coach A

    const res = await patchGame(20, { ...baseGameBody(), videoObjectPath: PATH_A });
    expect(res.status).toBe(409);

    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/already owned/i);

    // Restore the default state-based implementation for subsequent tests.
    (vi.mocked(db.query.gamesTable.findFirst) as any).mockImplementation(async () => {
      if (gamesFinderState.value === "coach-a-owns-path") return COACH_A_GAME_ROW();
      return undefined;
    });
  });

  it("returns 409 when Coach B patches their own game to reference a path whose ACL names Coach A", async () => {
    /**
     * Same as above, but the guard fires via ACL metadata rather than a DB row.
     * DB linkage check finds nothing (PATH_A has no game row yet),
     * but the ACL metadata says owner = Coach A.
     */
    currentUser.value = COACH_B;
    aclState.value = { owner: String(COACH_A.id), visibility: "private" };

    const { db } = await import("@workspace/db");
    (vi.mocked(db.query.gamesTable.findFirst) as any)
      .mockImplementationOnce(async () => COACH_B_GAME_ROW()) // ownership check for game 20
      .mockImplementation(async () => undefined);              // no DB linkage → ACL guard fires

    const res = await patchGame(20, { ...baseGameBody(), videoObjectPath: PATH_A });
    expect(res.status).toBe(409);

    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/already owned/i);

    (vi.mocked(db.query.gamesTable.findFirst) as any).mockImplementation(async () => {
      if (gamesFinderState.value === "coach-a-owns-path") return COACH_A_GAME_ROW();
      return undefined;
    });
  });

  it("returns 409 when Coach B patches to reference a path already in Coach A's highlightObjectPath (DB linkage via highlight column)", async () => {
    /**
     * PATH_A is stored in Coach A's highlightObjectPath, not videoObjectPath.
     * claimVideoObjectPath checks both columns; the highlightObjectPath branch
     * must still fire even when the videoObjectPath branch finds nothing.
     *
     * Mock layout:
     *   call 1 — ownership check for game 20         → COACH_B_GAME_ROW
     *   call 2 — videoObjectPath check               → undefined (no match)
     *   call 3 — highlightObjectPath check           → COACH_A_HIGHLIGHT_GAME_ROW
     */
    currentUser.value = COACH_B;
    aclState.value = null; // No ACL metadata; guard must fire via DB

    const { db } = await import("@workspace/db");
    (vi.mocked(db.query.gamesTable.findFirst) as any)
      .mockImplementationOnce(async () => COACH_B_GAME_ROW())          // call 1: game ownership
      .mockImplementationOnce(async () => undefined)                    // call 2: videoObjectPath → no match
      .mockImplementation(async () => COACH_A_HIGHLIGHT_GAME_ROW());   // call 3: highlightObjectPath → Coach A

    const res = await patchGame(20, { ...baseGameBody(), videoObjectPath: PATH_A });
    expect(res.status).toBe(409);

    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/already owned/i);

    // Restore the default state-based implementation for subsequent tests.
    (vi.mocked(db.query.gamesTable.findFirst) as any).mockImplementation(async () => {
      if (gamesFinderState.value === "coach-a-owns-path") return COACH_A_GAME_ROW();
      return undefined;
    });
  });

  it("returns 409 when Coach B patches to reference a path already in Coach A's lowlightObjectPath (DB linkage via lowlight column)", async () => {
    /**
     * PATH_A is stored in Coach A's lowlightObjectPath, not videoObjectPath or
     * highlightObjectPath.  claimVideoObjectPath checks all three columns;
     * the lowlightObjectPath branch must still fire even when the other two
     * branches find nothing.
     *
     * Mock layout:
     *   call 1 — ownership check for game 20          → COACH_B_GAME_ROW
     *   call 2 — videoObjectPath check                → undefined (no match)
     *   call 3 — highlightObjectPath check            → undefined (no match)
     *   call 4 — lowlightObjectPath check             → COACH_A_LOWLIGHT_GAME_ROW
     */
    currentUser.value = COACH_B;
    aclState.value = null; // No ACL metadata; guard must fire via DB

    const { db } = await import("@workspace/db");
    (vi.mocked(db.query.gamesTable.findFirst) as any)
      .mockImplementationOnce(async () => COACH_B_GAME_ROW())          // call 1: game ownership
      .mockImplementationOnce(async () => undefined)                    // call 2: videoObjectPath → no match
      .mockImplementationOnce(async () => undefined)                    // call 3: highlightObjectPath → no match
      .mockImplementation(async () => COACH_A_LOWLIGHT_GAME_ROW());    // call 4: lowlightObjectPath → Coach A

    const res = await patchGame(20, { ...baseGameBody(), videoObjectPath: PATH_A });
    expect(res.status).toBe(409);

    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/already owned/i);

    // Restore the default state-based implementation for subsequent tests.
    (vi.mocked(db.query.gamesTable.findFirst) as any).mockImplementation(async () => {
      if (gamesFinderState.value === "coach-a-owns-path") return COACH_A_GAME_ROW();
      return undefined;
    });
  });
});
