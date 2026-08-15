/**
 * GET /teams/:teamId/highlight — post-restart notification recovery
 *
 * Verifies two behaviours around the in-memory `teamHighlightInFlight` set
 * being cleared on server restart:
 *
 *   1. RESTART SCENARIO — reel is "ready" in the DB but
 *      `highlightNotificationSent` is still false (server died between the
 *      GCS upload and the flag write).  The GET handler must call
 *      `maybeSendTeamHighlightNotification` on the very next status poll,
 *      and must NOT call it again once the flag is true.
 *
 *   2. STALE-PROCESSING RESET — a job left in "processing" after a restart is
 *      reset to "failed" by the GET handler.  That DB write must NOT include
 *      `highlightNotificationSent: false` so a previously-notified coach is
 *      not re-notified for the same reel on a subsequent retry.
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
  maybeSendTeamHighlightNotificationMock,
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
  const maybeSendTeamHighlightNotificationMock = vi.fn().mockResolvedValue(undefined);

  return {
    currentUser,
    findFirstMock,
    dbUpdateSetMock,
    dbUpdateWhereMock,
    dbUpdateMock,
    countEligibleMock,
    maybeSendTeamHighlightNotificationMock,
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
      teamsTable: { findFirst: findFirstMock },
    },
    update: dbUpdateMock,
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ count: 0 }]),
      }),
    }),
  },
  teamsTable: "teamsTable",
  gamesTable: "gamesTable",
  playersTable: "playersTable",
  playerGameStatsTable: "playerGameStatsTable",
  gameEventsTable: "gameEventsTable",
}));

vi.mock("../../lib/entitlements", () => ({
  getEntitlementsForUser: vi.fn().mockResolvedValue({ plan: "pro", hasSoccer: true }),
  getEntitlements: vi.fn().mockResolvedValue({ plan: "pro", hasSoccer: true }),
  isPro: vi.fn().mockReturnValue(true),
}));

vi.mock("../../lib/highlightGenerator", () => ({
  countEligibleMomentsForTeam: countEligibleMock,
  generateTeamHighlight: vi.fn().mockResolvedValue(undefined),
  maybeSendTeamHighlightNotification: maybeSendTeamHighlightNotificationMock,
  GENERATOR_VERSION: 10,
  PROXY_VERSION: 6,
  MAX_PROXY_BUILD_DURATION_SEC: 900,
}));

vi.mock("../../lib/season", () => ({
  getCurrentSeasonStartDate: vi.fn().mockReturnValue("2024-09-01"),
}));

vi.mock("drizzle-orm", async (importActual) => {
  const actual = await importActual<typeof import("drizzle-orm")>();
  return { ...actual };
});

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------

import teamsRouter from "../teams";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", teamsRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://localhost:${port}/api`;
});

afterAll(() => {
  server.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A team row as it would appear immediately after a server restart. */
function makeTeam(overrides: Partial<{
  highlightStatus: string | null;
  highlightNotificationSent: boolean;
  highlightStartedAt: Date | null;
  highlightGeneratorVersion: number | null;
  highlightObjectPath: string | null;
}> = {}) {
  return {
    id: 42,
    name: "Varsity Bears",
    ownerId: 7,
    highlightStatus: "highlightStatus" in overrides ? overrides.highlightStatus : null,
    highlightNotificationSent: overrides.highlightNotificationSent ?? false,
    highlightStartedAt: "highlightStartedAt" in overrides ? overrides.highlightStartedAt : null,
    highlightObjectPath: overrides.highlightObjectPath ?? "reels/team42.mp4",
    highlightError: null,
    highlightGeneratorVersion: overrides.highlightGeneratorVersion ?? 10, // matches GENERATOR_VERSION
    createdAt: new Date(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbUpdateWhereMock.mockResolvedValue([]);
  dbUpdateSetMock.mockReturnValue({ where: dbUpdateWhereMock });
  dbUpdateMock.mockReturnValue({ set: dbUpdateSetMock });
  countEligibleMock.mockResolvedValue(3);
  maybeSendTeamHighlightNotificationMock.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// 1. Post-restart notification recovery
// ---------------------------------------------------------------------------

describe("GET /teams/:teamId/highlight — post-restart notification recovery", () => {
  it("calls maybeSendTeamHighlightNotification when reel is ready but flag is false", async () => {
    // Simulate: reel finished, server died before writing highlightNotificationSent=true.
    findFirstMock.mockResolvedValue(
      makeTeam({ highlightStatus: "ready", highlightNotificationSent: false }),
    );

    const res = await fetch(`${baseUrl}/teams/42/highlight`);
    expect(res.status).toBe(200);

    // Give the void promise a tick to start
    await new Promise((r) => setTimeout(r, 0));

    expect(maybeSendTeamHighlightNotificationMock).toHaveBeenCalledOnce();
    expect(maybeSendTeamHighlightNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 42, highlightNotificationSent: false }),
    );
  });

  it("does NOT call maybeSendTeamHighlightNotification when flag is already true", async () => {
    // Notification was already sent before the restart — must not fire again.
    findFirstMock.mockResolvedValue(
      makeTeam({ highlightStatus: "ready", highlightNotificationSent: true }),
    );

    const res = await fetch(`${baseUrl}/teams/42/highlight`);
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 0));

    expect(maybeSendTeamHighlightNotificationMock).not.toHaveBeenCalled();
  });

  it("does NOT call maybeSendTeamHighlightNotification when status is processing", async () => {
    findFirstMock.mockResolvedValue(
      makeTeam({
        highlightStatus: "processing",
        highlightNotificationSent: false,
        // Recent start so it's not treated as stale
        highlightStartedAt: new Date(),
      }),
    );

    const res = await fetch(`${baseUrl}/teams/42/highlight`);
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 0));

    expect(maybeSendTeamHighlightNotificationMock).not.toHaveBeenCalled();
  });

  it("does NOT call maybeSendTeamHighlightNotification when status is failed", async () => {
    findFirstMock.mockResolvedValue(
      makeTeam({ highlightStatus: "failed", highlightNotificationSent: false }),
    );

    await fetch(`${baseUrl}/teams/42/highlight`);
    await new Promise((r) => setTimeout(r, 0));

    expect(maybeSendTeamHighlightNotificationMock).not.toHaveBeenCalled();
  });

  it("returns status ready in the response body when recovering the notification", async () => {
    findFirstMock.mockResolvedValue(
      makeTeam({
        highlightStatus: "ready",
        highlightNotificationSent: false,
        highlightObjectPath: "reels/team42.mp4",
      }),
    );

    const res = await fetch(`${baseUrl}/teams/42/highlight`);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("ready");
  });
});

// ---------------------------------------------------------------------------
// 2. Stale-processing reset must NOT touch highlightNotificationSent
// ---------------------------------------------------------------------------

describe("GET /teams/:teamId/highlight — stale-processing reset preserves highlightNotificationSent", () => {
  /** A timestamp old enough to be considered stale (> 140 minutes). */
  const staleStartedAt = new Date(Date.now() - 141 * 60 * 1000);

  it("resets stale processing to failed without including highlightNotificationSent in the update", async () => {
    findFirstMock.mockResolvedValue(
      makeTeam({
        highlightStatus: "processing",
        highlightNotificationSent: false,
        highlightStartedAt: staleStartedAt,
      }),
    );

    const res = await fetch(`${baseUrl}/teams/42/highlight`);
    expect(res.status).toBe(200);

    // The stale reset should have triggered a DB update
    expect(dbUpdateMock).toHaveBeenCalled();

    // Inspect every set() call — none should include highlightNotificationSent
    for (const call of dbUpdateSetMock.mock.calls) {
      const payload = call[0] as Record<string, unknown>;
      expect(payload).not.toHaveProperty("highlightNotificationSent");
    }
  });

  it("reports failed status to the client after a stale-processing reset", async () => {
    findFirstMock.mockResolvedValue(
      makeTeam({
        highlightStatus: "processing",
        highlightNotificationSent: true, // flag was set from a previous reel
        highlightStartedAt: staleStartedAt,
      }),
    );

    const res = await fetch(`${baseUrl}/teams/42/highlight`);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("failed");
  });

  it("does NOT call maybeSendTeamHighlightNotification after a stale-processing reset", async () => {
    // After reset, status becomes "failed", so the notification guard should not fire.
    findFirstMock.mockResolvedValue(
      makeTeam({
        highlightStatus: "processing",
        highlightNotificationSent: false,
        highlightStartedAt: staleStartedAt,
      }),
    );

    await fetch(`${baseUrl}/teams/42/highlight`);
    await new Promise((r) => setTimeout(r, 0));

    expect(maybeSendTeamHighlightNotificationMock).not.toHaveBeenCalled();
  });
});
