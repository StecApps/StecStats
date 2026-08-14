/**
 * POST /games/:gameId/highlight — highlightNotificationSent flag reset
 *
 * Verifies that when a coach triggers a new per-game highlight generation the
 * route resets `highlightNotificationSent` to `false` in the DB update so
 * that `maybeSendGameHighlightNotification` will fire again when the new reel
 * is ready — i.e. coaches are not silently skipped because an older reel
 * already flipped the flag.
 *
 * Mirrors the pattern in teamHighlightFlagReset.test.ts.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";

// ---------------------------------------------------------------------------
// Hoisted shared fixtures
// ---------------------------------------------------------------------------
const {
  currentUser,
  findFirstMock,
  dbUpdateSetMock,
  dbUpdateWhereMock,
  dbUpdateMock,
  countEligibleMock,
  generateHighlightMock,
} = vi.hoisted(() => {
  const currentUser = {
    value: { id: 7, clerkUserId: "clerk_coach", email: "coach@example.com" } as {
      id: number;
      clerkUserId: string;
      email: string;
    },
  };

  const dbUpdateWhereMock = vi.fn().mockResolvedValue([]);
  const dbUpdateSetMock = vi.fn().mockReturnValue({ where: dbUpdateWhereMock });
  const dbUpdateMock = vi.fn().mockReturnValue({ set: dbUpdateSetMock });

  const findFirstMock = vi.fn();
  const countEligibleMock = vi.fn().mockResolvedValue(3);
  const generateHighlightMock = vi.fn().mockResolvedValue(undefined);

  return {
    currentUser,
    findFirstMock,
    dbUpdateSetMock,
    dbUpdateWhereMock,
    dbUpdateMock,
    countEligibleMock,
    generateHighlightMock,
  };
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("../../middlewares/requireAuth", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.appUser = { ...currentUser.value } as express.Request["appUser"];
    next();
  },
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

vi.mock("@workspace/db", () => ({
  db: {
    query: {
      gamesTable: { findFirst: findFirstMock },
    },
    update: dbUpdateMock,
  },
  gamesTable: "gamesTable",
  usersTable: "usersTable",
}));

vi.mock("../../lib/entitlements", () => ({
  getEntitlementsForUser: vi.fn().mockResolvedValue({ plan: "pro" }),
  getEntitlements: vi.fn().mockResolvedValue({ plan: "pro" }),
  isPro: vi.fn().mockReturnValue(true),
}));

vi.mock("../../lib/highlightGenerator", () => ({
  countEligibleMoments: countEligibleMock,
  generateHighlight: generateHighlightMock,
  cancelHighlightJob: vi.fn(),
  getHighlightCoverage: vi.fn().mockResolvedValue({ eligibleMoments: 3, onFilmMoments: 3 }),
  GENERATOR_VERSION: 10,
}));

vi.mock("../../lib/videoDuration", () => ({
  scheduleVideoDurationProbe: vi.fn(),
}));

vi.mock("../../lib/musicTracks", () => ({
  getMusicTrackPath: vi.fn().mockReturnValue(undefined),
}));

vi.mock("drizzle-orm", async (importActual) => {
  const actual = await importActual<typeof import("drizzle-orm")>();
  return { ...actual };
});

// ---------------------------------------------------------------------------
// Server bootstrap — runs once after mocks are in place
// ---------------------------------------------------------------------------

import highlightsRouter from "../highlights";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", highlightsRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://localhost:${port}/api`;
});

afterAll(() => {
  server.close();
});

// ---------------------------------------------------------------------------
// Helper — a game row
// ---------------------------------------------------------------------------

function makeGame(overrides: Partial<{
  highlightStatus: string | null;
  highlightNotificationSent: boolean;
  highlightStartedAt: Date | null;
  videoObjectPath: string | null;
}> = {}) {
  return {
    id: 99,
    ownerId: 7,
    opponent: "Riverside Hawks",
    videoObjectPath: overrides.videoObjectPath !== undefined ? overrides.videoObjectPath : "/objects/private/game-99.mp4",
    highlightStatus: overrides.highlightStatus ?? null,
    highlightNotificationSent: overrides.highlightNotificationSent ?? false,
    highlightStartedAt: overrides.highlightStartedAt ?? null,
    highlightObjectPath: null,
    highlightError: null,
    highlightGeneratorVersion: null,
    highlightMusicTrack: null,
    highlightYoutubeUrl: null,
    videoDurationMs: 1000,
    createdAt: new Date(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbUpdateWhereMock.mockResolvedValue([]);
  dbUpdateSetMock.mockReturnValue({ where: dbUpdateWhereMock });
  dbUpdateMock.mockReturnValue({ set: dbUpdateSetMock });
  countEligibleMock.mockResolvedValue(3);
  generateHighlightMock.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /games/:gameId/highlight — highlightNotificationSent flag reset", () => {
  it("resets highlightNotificationSent to false when starting a new generation", async () => {
    // Game has already been notified about a previous reel.
    findFirstMock.mockResolvedValue(makeGame({ highlightNotificationSent: true }));

    const res = await fetch(`${baseUrl}/games/99/highlight`, { method: "POST" });
    expect(res.status).toBe(202);

    // The DB update must include highlightNotificationSent: false so the new
    // reel triggers a fresh notification when it completes.
    expect(dbUpdateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ highlightNotificationSent: false }),
    );
  });

  it("resets the flag even when the previous reel was in the ready state", async () => {
    findFirstMock.mockResolvedValue(
      makeGame({ highlightStatus: "ready", highlightNotificationSent: true }),
    );

    await fetch(`${baseUrl}/games/99/highlight`, { method: "POST" });

    expect(dbUpdateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ highlightNotificationSent: false }),
    );
  });

  it("also resets the flag when the previous reel had failed and the coach retries", async () => {
    findFirstMock.mockResolvedValue(
      makeGame({ highlightStatus: "failed", highlightNotificationSent: false }),
    );

    await fetch(`${baseUrl}/games/99/highlight`, { method: "POST" });

    expect(dbUpdateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ highlightNotificationSent: false }),
    );
  });

  it("sets highlightStatus to processing in the same DB call", async () => {
    findFirstMock.mockResolvedValue(makeGame({ highlightNotificationSent: true }));

    await fetch(`${baseUrl}/games/99/highlight`, { method: "POST" });

    expect(dbUpdateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        highlightStatus: "processing",
        highlightNotificationSent: false,
      }),
    );
  });

  it("does NOT reset or update the DB when a job is already in flight", async () => {
    // Simulate an in-flight job: status=processing with a recent startedAt.
    findFirstMock.mockResolvedValue(
      makeGame({
        highlightStatus: "processing",
        highlightNotificationSent: false,
        highlightStartedAt: new Date(), // started just now — not stale
      }),
    );

    const res = await fetch(`${baseUrl}/games/99/highlight`, { method: "POST" });
    // Should still 202 but without re-triggering the job
    expect(res.status).toBe(202);
    // The route must NOT call db.update when it detects alreadyRunning
    expect(dbUpdateMock).not.toHaveBeenCalled();
  });
});
