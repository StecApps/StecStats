/**
 * DELETE /games/:gameId — GCS blob cleanup regression test
 *
 * Verifies that deleting a game also triggers deleteObjectEntity() for
 * both videoObjectPath and highlightObjectPath so no orphaned blobs are
 * left accessible after deletion.
 *
 * Covers:
 *   - Blob cleanup is attempted for video + highlight paths
 *   - Normalized /objects/... paths and legacy absolute GCS URLs both work
 *   - Deleting a non-existent (or foreign) game returns 204 without blob cleanup
 *   - A game with no video paths returns 204 without attempting blob deletion
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";

// ---------------------------------------------------------------------------
// Test fixtures — hoisted so mock factories can reference them
// ---------------------------------------------------------------------------
const { COACH_A, COACH_B, currentUser, deleteObjectEntityMock, normalizePathMock, dbDeleteMock, findFirstMock } =
  vi.hoisted(() => {
    const COACH_A = { id: 1, clerkUserId: "clerk_coach_a", email: "coach-a@example.com" };
    const COACH_B = { id: 2, clerkUserId: "clerk_coach_b", email: "coach-b@example.com" };
    const currentUser = { value: COACH_A as typeof COACH_A };
    const deleteObjectEntityMock = vi.fn().mockResolvedValue(undefined);
    const normalizePathMock = vi.fn().mockImplementation((path: string) => path);
    const dbDeleteMock = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const findFirstMock = vi.fn();
    return { COACH_A, COACH_B, currentUser, deleteObjectEntityMock, normalizePathMock, dbDeleteMock, findFirstMock };
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
      playersTable: { findFirst: vi.fn().mockResolvedValue(undefined) },
      teamsTable: { findFirst: vi.fn().mockResolvedValue(undefined) },
      playerGameStatsTable: { findMany: vi.fn().mockResolvedValue([]) },
      gameEventsTable: { findMany: vi.fn().mockResolvedValue([]) },
    },
    delete: dbDeleteMock,
    update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) }),
  },
  gamesTable: { id: "id", ownerId: "owner_id", videoObjectPath: "video_object_path", highlightObjectPath: "highlight_object_path" },
  playerGameStatsTable: { gameId: "game_id" },
  gameEventsTable: { gameId: "game_id" },
  teamsTable: {},
  playersTable: {},
}));

vi.mock("../../lib/objectStorage", () => {
  class ObjectStorageService {
    deleteObjectEntity = deleteObjectEntityMock;
    normalizeObjectEntityPath = normalizePathMock;
    getObjectEntityFile = vi.fn().mockRejectedValue(new (class ObjectNotFoundError extends Error {
      constructor() { super("Not found"); this.name = "ObjectNotFoundError"; }
    })());
    canAccessObjectEntity = vi.fn().mockResolvedValue(false);
    getObjectEntitySignedURL = vi.fn().mockResolvedValue("https://storage.googleapis.com/signed");
    trySetObjectEntityAclPolicy = vi.fn().mockResolvedValue(undefined);
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

vi.mock("../../lib/videoDuration", () => ({
  scheduleVideoDurationProbe: vi.fn(),
}));

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
  currentUser.value = COACH_A;
  deleteObjectEntityMock.mockClear();
  normalizePathMock.mockClear();
  normalizePathMock.mockImplementation((path: string) => path);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function deleteGame(gameId: number) {
  return fetch(`${baseUrl}/api/games/${gameId}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DELETE /api/games/:gameId — GCS blob cleanup", () => {
  it("calls deleteObjectEntity for both video and highlight paths when both are set", async () => {
    findFirstMock.mockResolvedValueOnce({
      id: 42,
      ownerId: COACH_A.id,
      videoObjectPath: "/objects/uploads/1/video.mp4",
      highlightObjectPath: "/objects/uploads/1/highlight.mp4",
    });

    const res = await deleteGame(42);
    expect(res.status).toBe(204);

    expect(deleteObjectEntityMock).toHaveBeenCalledTimes(2);
    expect(deleteObjectEntityMock).toHaveBeenCalledWith("/objects/uploads/1/video.mp4");
    expect(deleteObjectEntityMock).toHaveBeenCalledWith("/objects/uploads/1/highlight.mp4");
  });

  it("calls deleteObjectEntity only for video when highlight path is null", async () => {
    findFirstMock.mockResolvedValueOnce({
      id: 43,
      ownerId: COACH_A.id,
      videoObjectPath: "/objects/uploads/1/video-only.mp4",
      highlightObjectPath: null,
    });

    const res = await deleteGame(43);
    expect(res.status).toBe(204);

    expect(deleteObjectEntityMock).toHaveBeenCalledTimes(1);
    expect(deleteObjectEntityMock).toHaveBeenCalledWith("/objects/uploads/1/video-only.mp4");
  });

  it("does not call deleteObjectEntity when both paths are null", async () => {
    findFirstMock.mockResolvedValueOnce({
      id: 44,
      ownerId: COACH_A.id,
      videoObjectPath: null,
      highlightObjectPath: null,
    });

    const res = await deleteGame(44);
    expect(res.status).toBe(204);
    expect(deleteObjectEntityMock).not.toHaveBeenCalled();
  });

  it("returns 204 without calling deleteObjectEntity when the game row is not found", async () => {
    findFirstMock.mockResolvedValueOnce(undefined);

    const res = await deleteGame(999);
    expect(res.status).toBe(204);
    expect(deleteObjectEntityMock).not.toHaveBeenCalled();
  });

  it("normalizes a legacy absolute GCS URL before calling deleteObjectEntity", async () => {
    const legacyUrl =
      "https://storage.googleapis.com/my-bucket/private/uploads/1/legacy-video.mp4";
    const normalizedPath = "/objects/uploads/1/legacy-video.mp4";

    normalizePathMock.mockImplementation((path: string) =>
      path.startsWith("https://") ? normalizedPath : path
    );

    findFirstMock.mockResolvedValueOnce({
      id: 45,
      ownerId: COACH_A.id,
      videoObjectPath: legacyUrl,
      highlightObjectPath: null,
    });

    const res = await deleteGame(45);
    expect(res.status).toBe(204);

    expect(normalizePathMock).toHaveBeenCalledWith(legacyUrl);
    expect(deleteObjectEntityMock).toHaveBeenCalledWith(normalizedPath);
  });

  it("still returns 204 when deleteObjectEntity throws (best-effort cleanup)", async () => {
    findFirstMock.mockResolvedValueOnce({
      id: 46,
      ownerId: COACH_A.id,
      videoObjectPath: "/objects/uploads/1/fail-video.mp4",
      highlightObjectPath: null,
    });

    deleteObjectEntityMock.mockRejectedValueOnce(new Error("GCS timeout"));

    const res = await deleteGame(46);
    expect(res.status).toBe(204);
  });
});
