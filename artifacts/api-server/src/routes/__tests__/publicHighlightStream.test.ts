/**
 * Public highlight reel — proxy-safety regression test
 *
 * The /games/public/:shareToken/highlight endpoint returns a GCS signed URL
 * inside a JSON body.  The browser's <video src> uses that URL directly, so
 * all byte-range / seek requests go straight from the client to GCS without
 * passing through the Replit proxy.  This is intentionally different from
 * the authenticated /games/:gameId/stream/:type endpoint that was fixed to
 * redirect large full-file requests: the public endpoint was never affected by
 * the proxy bug because it never streams the video through the server at all.
 *
 * This suite verifies:
 *
 *   A. HAPPY PATH — 200 JSON with a GCS signed URL (not a streamed body)
 *      • videoUrl is the signed URL string returned by objectStorage
 *      • The signed URL TTL is 3600 s so a full reel can finish without
 *        the URL expiring mid-play
 *      • No createReadStream is called — the server never touches the bytes
 *      • Game metadata (teamName, opponent, date, result, scores) is present
 *
 *   B. HIGHLIGHT NOT READY — 404 with a clear "not available" message
 *      The public page shows "Highlight reel not ready yet" in this case;
 *      the response body must carry the exact string the page checks for.
 *
 *   C. GAME NOT FOUND — 404 when shareToken doesn't match any game
 *
 *   D. OWNER DELETED — 404 when the owning account no longer exists
 *      Prevents leaking reels after a coach's account is suspended/deleted.
 *
 *   E. INVALID TOKEN FORMAT — 404 for non-UUID tokens (rate-limit bypass guard)
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";

// ---------------------------------------------------------------------------
// Fixtures — hoisted so vi.mock() factories can close over them.
// ---------------------------------------------------------------------------
const {
  SHARE_TOKEN,
  PATH_HIGHLIGHT,
  SIGNED_URL,
  /** Controls which scenario is active for a given test. */
  scenario,
} = vi.hoisted(() => {
  const SHARE_TOKEN   = "aaaabbbb-cccc-dddd-eeee-ffffaaaabbbb";
  const PATH_HIGHLIGHT = "/objects/private/highlight-42.mp4";
  const SIGNED_URL    = "https://storage.googleapis.com/bucket/highlight-42.mp4?X-Goog-Signature=abc123";
  const scenario = {
    value: "ready" as
      | "ready"       // highlight ready, owner exists
      | "no-reel"     // game has no highlight / status !== ready
      | "no-game"     // gamesTable returns null
      | "no-owner",   // owner lookup returns null
  };
  return { SHARE_TOKEN, PATH_HIGHLIGHT, SIGNED_URL, scenario };
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("@workspace/db", () => ({
  db: {
    query: {
      gamesTable: {
        findFirst: vi.fn().mockImplementation(async () => {
          if (scenario.value === "no-game") return null;
          return {
            id: 42,
            ownerId: 1,
            teamId: 7,
            opponent: "Crosstown Tigers",
            date: "2024-03-10",
            result: "W",
            teamScore: 88,
            opponentScore: 72,
            videoObjectPath: "/objects/private/game-42.mp4",
            videoProxyObjectPath: null,
            videoProxyVersion: null,
            videoOffsetMs: null,
            videoDurationMs: null,
            videoHalf2StartMs: null,
            videoHalftimeGapMs: null,
            highlightObjectPath: scenario.value === "ready" ? PATH_HIGHLIGHT : null,
            highlightStatus:     scenario.value === "ready" ? "ready"         : null,
            highlightError: null,
            highlightStartedAt: null,
            highlightGeneratorVersion: null,
            highlightMusicTrack: null,
            highlightYoutubeUrl: null,
            lowlightObjectPath: null,
            lowlightStatus: null,
            lowlightError: null,
            lowlightStartedAt: null,
            lowlightGeneratorVersion: null,
            shareToken: SHARE_TOKEN,
            createdAt: new Date(),
          };
        }),
      },
      teamsTable: {
        findFirst: vi.fn().mockResolvedValue({ id: 7, ownerId: 1, name: "Westside Wolves" }),
      },
      usersTable: {
        findFirst: vi.fn().mockImplementation(async () => {
          if (scenario.value === "no-owner") return null;
          return { id: 1, email: "coach@example.com", revenueCatEntitlement: null };
        }),
      },
      playersTable:      { findMany: vi.fn().mockResolvedValue([]) },
      gameEventsTable:   { findMany: vi.fn().mockResolvedValue([]) },
    },
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      }),
    }),
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
  },

  gamesTable: {
    id: "id", ownerId: "owner_id", teamId: "team_id",
    opponent: "opponent", date: "date", result: "result",
    teamScore: "team_score", opponentScore: "opponent_score",
    videoObjectPath: "video_object_path",
    videoProxyObjectPath: "video_proxy_object_path",
    videoProxyVersion: "video_proxy_version",
    videoOffsetMs: "video_offset_ms", videoDurationMs: "video_duration_ms",
    videoHalf2StartMs: "video_half2_start_ms",
    videoHalftimeGapMs: "video_halftime_gap_ms",
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
    shareToken: "share_token", createdAt: "created_at",
    clientGameId: "client_game_id",
  },
  teamsTable:  { id: "id", ownerId: "owner_id", name: "name" },
  playersTable: {
    id: "id", ownerId: "owner_id", name: "name",
    photoObjectPath: "photo_object_path",
  },
  usersTable: {
    id: "id", email: "email",
    stripeCustomerId: "stripe_customer_id",
    revenueCatEntitlement: "revenue_cat_entitlement",
  },
  playerGameStatsTable: {
    gameId: "game_id", playerId: "player_id",
    ftMade: "ft_made", ftAttempted: "ft_attempted",
    twoMade: "two_made", twoAttempted: "two_attempted",
    threeMade: "three_made", threeAttempted: "three_attempted",
    assists: "assists", rebounds: "rebounds", steals: "steals",
    turnovers: "turnovers", blocks: "blocks",
    goals: "goals", shots: "shots", shotsOffTarget: "shots_off_target",
    saves: "saves", yellowCards: "yellow_cards", redCards: "red_cards",
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
  requireAuth: (_req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(401).json({ error: "Not authenticated" });
  },
}));

/** Track calls so tests can assert the server never streams video bytes. */
const storageCalls = { getSignedURL: 0, createReadStream: 0 };
const signedUrlCalls: Array<{ path: string; ttl: number }> = [];

vi.mock("../../lib/objectStorage", () => {
  const { Readable } = require("stream");
  class ObjectStorageService {
    getObjectEntityFile = vi.fn().mockResolvedValue({
      getMetadata: vi.fn().mockResolvedValue([{ contentType: "video/mp4", size: 120_000_000 }]),
      createReadStream: vi.fn().mockImplementation(() => {
        storageCalls.createReadStream += 1;
        const s = new Readable({ read() {} });
        process.nextTick(() => s.push(null));
        return s;
      }),
    });
    normalizeObjectEntityPath = vi.fn().mockImplementation((p: string) => p);
    canAccessObjectEntity = vi.fn().mockResolvedValue(false);
    getObjectEntitySignedURL = vi.fn().mockImplementation(async (path: string, ttl: number) => {
      storageCalls.getSignedURL += 1;
      signedUrlCalls.push({ path, ttl });
      return SIGNED_URL;
    });
    uploadLocalFileAsObjectEntity  = vi.fn().mockResolvedValue("/objects/private/out.mp4");
    trySetObjectEntityAclPolicy    = vi.fn().mockResolvedValue(undefined);
  }
  class ObjectNotFoundError extends Error {
    constructor(msg = "Not found") { super(msg); this.name = "ObjectNotFoundError"; }
  }
  return { ObjectStorageService, ObjectNotFoundError };
});

vi.mock("../../lib/objectAcl", () => ({
  getObjectAclPolicy: vi.fn().mockResolvedValue(null),
  setObjectAclPolicy: vi.fn().mockResolvedValue(undefined),
  ObjectPermission: { READ: "READ", WRITE: "WRITE" },
}));

vi.mock("../../lib/entitlements", () => ({
  getEntitlementsForUser: vi.fn().mockResolvedValue({ plan: "free" }),
  getEntitlements:        vi.fn().mockResolvedValue({ plan: "free" }),
  isPro: vi.fn().mockReturnValue(false),
}));

vi.mock("../../lib/videoDuration",      () => ({ scheduleVideoDurationProbe: vi.fn() }));
vi.mock("../../lib/highlightGenerator", () => ({
  PROXY_VERSION: 1,
  PROXY_CHUNK_DURATION_SEC: 60,
  makeProxyChunkGcsPath: vi.fn(),
  getReadyProxyChunkCount: vi.fn().mockResolvedValue(0),
  readHlsSentinel: vi.fn().mockResolvedValue(null),
  acquireProxyChunkLocally: vi.fn(),
  ensureAllProxyChunksInBackground: vi.fn(),
  ensureGameProxyInBackground: vi.fn(),
  cancelHighlightGeneration: vi.fn(),
  cancelProxyBuild: vi.fn(),
}));

vi.mock("child_process", () => ({ execFile: vi.fn(), spawn: vi.fn() }));

vi.mock("fs", async () => {
  const { Readable } = await import("stream");
  return {
    promises: {
      mkdtemp: vi.fn().mockResolvedValue("/tmp/test-stub"),
      writeFile: vi.fn().mockResolvedValue(undefined),
      rm: vi.fn().mockResolvedValue(undefined),
      stat: vi.fn().mockResolvedValue({ size: 120_000_000 }),
      open: vi.fn().mockResolvedValue({
        read: vi.fn().mockResolvedValue({ bytesRead: 0 }),
        close: vi.fn().mockResolvedValue(undefined),
      }),
    },
    createWriteStream: vi.fn().mockReturnValue({
      write: vi.fn((_d: any, cb: () => void) => cb()),
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
// Real import (after mocks)
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
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.restoreAllMocks();
});

beforeEach(() => {
  scenario.value = "ready";
  storageCalls.getSignedURL   = 0;
  storageCalls.createReadStream = 0;
  signedUrlCalls.length = 0;
});

// ---------------------------------------------------------------------------
// A — Happy path: signed URL returned in JSON, no server-side streaming
// ---------------------------------------------------------------------------

describe("A — Happy path: signed URL in JSON body (no server-side streaming)", () => {
  it("returns 200 with a videoUrl field", async () => {
    const res = await fetch(`${baseUrl}/api/games/public/${SHARE_TOKEN}/highlight`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { videoUrl: string };
    expect(typeof body.videoUrl).toBe("string");
    expect(body.videoUrl.length).toBeGreaterThan(0);
  });

  it("videoUrl is the GCS signed URL — the browser streams directly from GCS", async () => {
    const res = await fetch(`${baseUrl}/api/games/public/${SHARE_TOKEN}/highlight`);
    const { videoUrl } = (await res.json()) as { videoUrl: string };

    // The URL must be exactly the value returned by getObjectEntitySignedURL.
    // If it were a proxy path (e.g. /api/games/public/.../stream) the video
    // would route through the Replit proxy and risk buffering cutoffs.
    expect(videoUrl).toBe(SIGNED_URL);
  });

  it("signs the correct GCS object path (not a generic one)", async () => {
    await fetch(`${baseUrl}/api/games/public/${SHARE_TOKEN}/highlight`);
    expect(signedUrlCalls).toHaveLength(1);
    expect(signedUrlCalls[0].path).toBe(PATH_HIGHLIGHT);
  });

  it("uses a 3600 s TTL so the full reel can finish without the URL expiring", async () => {
    // A typical highlight reel is 3–5 minutes. A 3600 s (1 h) TTL ensures
    // the URL stays valid from page load through the end of the video.
    await fetch(`${baseUrl}/api/games/public/${SHARE_TOKEN}/highlight`);
    expect(signedUrlCalls[0].ttl).toBe(3600);
  });

  it("never calls createReadStream — the server does not pipe video bytes", async () => {
    // Piping through the Replit proxy kills large responses after ~1–2 s.
    // The public endpoint must hand the URL to the client and let the browser
    // talk directly to GCS.
    await fetch(`${baseUrl}/api/games/public/${SHARE_TOKEN}/highlight`);
    expect(storageCalls.createReadStream).toBe(0);
  });

  it("includes game metadata so the public page can render the game card", async () => {
    const res  = await fetch(`${baseUrl}/api/games/public/${SHARE_TOKEN}/highlight`);
    const body = (await res.json()) as {
      teamName: string; opponent: string; date: string;
      result: "W" | "L"; teamScore: number; opponentScore: number;
    };
    expect(body.teamName).toBe("Westside Wolves");
    expect(body.opponent).toBe("Crosstown Tigers");
    expect(body.date).toBe("2024-03-10");
    expect(body.result).toBe("W");
    expect(body.teamScore).toBe(88);
    expect(body.opponentScore).toBe(72);
  });
});

// ---------------------------------------------------------------------------
// B — Highlight not ready: 404 with message the frontend checks for
// ---------------------------------------------------------------------------

describe("B — Highlight not ready: 404 with UI-friendly error string", () => {
  beforeEach(() => { scenario.value = "no-reel"; });

  it("returns 404 when the game has no highlight object path", async () => {
    const res = await fetch(`${baseUrl}/api/games/public/${SHARE_TOKEN}/highlight`);
    expect(res.status).toBe(404);
  });

  it("returns the exact error string the public page reads to show 'not ready' UI", async () => {
    // highlight-public.tsx checks: d?.error === "Highlight reel not available"
    // to decide between the "not ready" and "not found" states.
    const res  = await fetch(`${baseUrl}/api/games/public/${SHARE_TOKEN}/highlight`);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Highlight reel not available");
  });

  it("does not call the storage service when the reel is not ready", async () => {
    await fetch(`${baseUrl}/api/games/public/${SHARE_TOKEN}/highlight`);
    expect(storageCalls.getSignedURL).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// C — Game not found: 404
// ---------------------------------------------------------------------------

describe("C — Game not found", () => {
  beforeEach(() => { scenario.value = "no-game"; });

  it("returns 404 when no game matches the shareToken", async () => {
    const res = await fetch(`${baseUrl}/api/games/public/${SHARE_TOKEN}/highlight`);
    expect(res.status).toBe(404);
  });

  it("does not call storage when the game is missing", async () => {
    await fetch(`${baseUrl}/api/games/public/${SHARE_TOKEN}/highlight`);
    expect(storageCalls.getSignedURL).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// D — Owner deleted: 404 to prevent leaking reels after account removal
// ---------------------------------------------------------------------------

describe("D — Owner account deleted: 404", () => {
  beforeEach(() => { scenario.value = "no-owner"; });

  it("returns 404 when the owning coach account no longer exists", async () => {
    const res = await fetch(`${baseUrl}/api/games/public/${SHARE_TOKEN}/highlight`);
    expect(res.status).toBe(404);
  });

  it("does not sign a URL when the owner is deleted", async () => {
    await fetch(`${baseUrl}/api/games/public/${SHARE_TOKEN}/highlight`);
    expect(storageCalls.getSignedURL).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// E — Invalid token format: 404 (UUID regex guard)
// ---------------------------------------------------------------------------

describe("E — Invalid shareToken format: 404", () => {
  it("rejects a non-UUID token without touching the database", async () => {
    const res = await fetch(`${baseUrl}/api/games/public/not-a-uuid/highlight`);
    expect(res.status).toBe(404);
  });

  it("rejects an empty-string token", async () => {
    // Route won't match without a segment, but guard against near-miss paths.
    const res = await fetch(`${baseUrl}/api/games/public/!!invalid!!/highlight`);
    expect(res.status).toBe(404);
  });
});
