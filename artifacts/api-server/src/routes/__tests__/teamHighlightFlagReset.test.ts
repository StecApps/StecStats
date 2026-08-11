/**
 * POST /teams/:teamId/highlight — highlightNotificationSent flag reset
 *
 * Verifies that when a coach triggers a new season-highlight generation the
 * route resets `highlightNotificationSent` to `false` in the DB update so
 * that `maybeSendTeamHighlightNotification` will fire again when the new reel
 * is ready — i.e. coaches are not silently skipped because an older reel
 * already flipped the flag.
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
  generateTeamHighlightMock,
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
  const generateTeamHighlightMock = vi.fn().mockResolvedValue(undefined);

  return {
    currentUser,
    findFirstMock,
    dbUpdateSetMock,
    dbUpdateWhereMock,
    dbUpdateMock,
    countEligibleMock,
    generateTeamHighlightMock,
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
  generateTeamHighlight: generateTeamHighlightMock,
  GENERATOR_VERSION: 10,
  PROXY_VERSION: 6,
  MAX_PROXY_BUILD_DURATION_SEC: 900,
}));

vi.mock("../../lib/season", () => ({
  getCurrentSeasonStartDate: vi.fn().mockReturnValue("2024-09-01"),
}));

// Drizzle helpers — real imports but safe as identities in the mock context
vi.mock("drizzle-orm", async (importActual) => {
  const actual = await importActual<typeof import("drizzle-orm")>();
  return { ...actual };
});

// ---------------------------------------------------------------------------
// Server bootstrap — runs once after mocks are in place
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
// Helper — a team row that owns a ready reel whose flag is already set
// ---------------------------------------------------------------------------

function makeTeam(overrides: Partial<{
  highlightStatus: string | null;
  highlightNotificationSent: boolean;
  highlightStartedAt: Date | null;
}> = {}) {
  return {
    id: 42,
    name: "Varsity Bears",
    ownerId: 7,
    highlightStatus: overrides.highlightStatus ?? null,
    highlightNotificationSent: overrides.highlightNotificationSent ?? false,
    highlightStartedAt: overrides.highlightStartedAt ?? null,
    highlightObjectPath: null,
    highlightError: null,
    highlightGeneratorVersion: null,
    createdAt: new Date(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Reset mocks to default resolved values
  dbUpdateWhereMock.mockResolvedValue([]);
  dbUpdateSetMock.mockReturnValue({ where: dbUpdateWhereMock });
  dbUpdateMock.mockReturnValue({ set: dbUpdateSetMock });
  countEligibleMock.mockResolvedValue(3);
  generateTeamHighlightMock.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /teams/:teamId/highlight — highlightNotificationSent flag reset", () => {
  it("resets highlightNotificationSent to false when starting a new generation", async () => {
    // Team has already been notified about a previous reel.
    findFirstMock.mockResolvedValue(makeTeam({ highlightNotificationSent: true }));

    const res = await fetch(`${baseUrl}/teams/42/highlight`, { method: "POST" });
    expect(res.status).toBe(202);

    // Inspect what the route wrote into the DB update.
    expect(dbUpdateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ highlightNotificationSent: false }),
    );
  });

  it("resets the flag even when the previous reel was in the ready state", async () => {
    findFirstMock.mockResolvedValue(
      makeTeam({ highlightStatus: "ready", highlightNotificationSent: true }),
    );

    await fetch(`${baseUrl}/teams/42/highlight`, { method: "POST" });

    expect(dbUpdateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ highlightNotificationSent: false }),
    );
  });

  it("also resets the flag when the previous reel had failed and the coach retries", async () => {
    findFirstMock.mockResolvedValue(
      makeTeam({ highlightStatus: "failed", highlightNotificationSent: false }),
    );

    await fetch(`${baseUrl}/teams/42/highlight`, { method: "POST" });

    expect(dbUpdateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ highlightNotificationSent: false }),
    );
  });

  it("sets highlightStatus to processing in the same DB call", async () => {
    findFirstMock.mockResolvedValue(makeTeam({ highlightNotificationSent: true }));

    await fetch(`${baseUrl}/teams/42/highlight`, { method: "POST" });

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
      makeTeam({
        highlightStatus: "processing",
        highlightNotificationSent: false,
        highlightStartedAt: new Date(), // started just now — not stale
      }),
    );

    const res = await fetch(`${baseUrl}/teams/42/highlight`, { method: "POST" });
    // Should still 202 but without re-triggering the job
    expect(res.status).toBe(202);
    // The route must NOT call db.update when it detects alreadyRunning
    expect(dbUpdateMock).not.toHaveBeenCalled();
  });
});
