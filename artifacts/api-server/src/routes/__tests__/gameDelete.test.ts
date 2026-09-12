/**
 * DELETE /games/:gameId — GCS blob cleanup regression test
 *
 * Verifies that deleting a game retains its original video master while
 * cleaning replaceable highlight, lowlight, proxy and HLS derivatives.
 *
 * Covers:
 *   - Master video is never passed to blob cleanup and is entered in retention
 *   - Normalized /objects/... paths and legacy absolute GCS URLs both work
 *   - Deleting a non-existent (or foreign) game returns 204 without blob cleanup
 *   - A game with no video paths returns 204 without attempting blob deletion
 *   - cancelHighlightGeneration and cancelProxyBuild are called on every delete
 *   - Proxy chunks are swept and deleted when they exist in GCS
 *   - The sweep stops at the first missing chunk
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";

// ---------------------------------------------------------------------------
// Test fixtures — hoisted so mock factories can reference them
// ---------------------------------------------------------------------------
const {
  COACH_A,
  COACH_B,
  currentUser,
  deleteObjectEntityMock,
  normalizePathMock,
  dbDeleteMock,
  findFirstMock,
  getObjectEntityFileMock,
  cancelHighlightGenerationMock,
  cancelProxyBuildMock,
  lockedGameOverride,
} = vi.hoisted(() => {
  const COACH_A = { id: 1, clerkUserId: "clerk_coach_a", email: "coach-a@example.com" };
  const COACH_B = { id: 2, clerkUserId: "clerk_coach_b", email: "coach-b@example.com" };
  const currentUser = { value: COACH_A as typeof COACH_A };
  const deleteObjectEntityMock = vi.fn().mockResolvedValue(undefined);
  const normalizePathMock = vi.fn().mockImplementation((path: string) => path);
  const dbDeleteMock = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
  const findFirstMock = vi.fn();
  const getObjectEntityFileMock = vi.fn().mockRejectedValue(
    new (class ObjectNotFoundError extends Error {
      constructor() { super("Not found"); this.name = "ObjectNotFoundError"; }
    })(),
  );
  const cancelHighlightGenerationMock = vi.fn();
  const cancelProxyBuildMock = vi.fn();
  const lockedGameOverride = { value: null as any };
  return {
    COACH_A, COACH_B, currentUser,
    deleteObjectEntityMock, normalizePathMock, dbDeleteMock, findFirstMock,
    getObjectEntityFileMock,
    cancelHighlightGenerationMock, cancelProxyBuildMock,
    lockedGameOverride,
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
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({ onConflictDoNothing: vi.fn().mockResolvedValue(undefined) }),
    }),
    update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) }),
    transaction: vi.fn().mockImplementation(async (work) => {
      const initialResult = findFirstMock.mock.results[findFirstMock.mock.results.length - 1];
      const initial = await initialResult?.value;
      const locked = lockedGameOverride.value ?? initial;
      const tx = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              for: vi.fn().mockImplementation(async () => locked ? [{ ...locked }] : []),
            }),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
          }),
        }),
        delete: dbDeleteMock,
      };
      return work(tx);
    }),
  },
  gamesTable: {
    id: "id",
    ownerId: "owner_id",
    videoObjectPath: "video_object_path",
    highlightObjectPath: "highlight_object_path",
    highlightClipManifest: "highlight_clip_manifest",
    highlightStatus: "highlight_status",
    highlightGeneratorVersion: "highlight_generator_version",
    lowlightObjectPath: "lowlight_object_path",
    videoProxyObjectPath: "video_proxy_object_path",
  },
  retainedGameFilmsTable: { objectPath: "object_path", ownerId: "owner_id" },
  playerGameStatsTable: { gameId: "game_id" },
  gameEventsTable: { gameId: "game_id" },
  teamsTable: {},
  playersTable: {},
}));

vi.mock("../../lib/objectStorage", () => {
  class ObjectStorageService {
    deleteObjectEntity = deleteObjectEntityMock;
    normalizeObjectEntityPath = normalizePathMock;
    getObjectEntityFile = getObjectEntityFileMock;
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

vi.mock("../../lib/highlightGenerator", () => ({
  PROXY_VERSION: "v5",
  PROXY_CHUNK_DURATION_SEC: 360,
  HLS_SEGMENT_DURATION_SEC: 60,
  makeProxyChunkGcsPath: vi.fn(),
  makeHlsChunkGcsPath: vi.fn((_ownerId, gameId, i) => `/hls/${gameId}/${i}`),
  makeHlsSegmentMetadataGcsPath: vi.fn((_ownerId, gameId, i) => `/hls-meta/${gameId}/${i}`),
  makeHlsSentinelGcsPath: vi.fn((_ownerId, gameId) => `/hls-sentinel/${gameId}`),
  getReadyProxyChunkCount: vi.fn().mockResolvedValue(-1),
  getPlayableProxyChunkCount: vi.fn().mockResolvedValue(0),
  readPlayableHlsSegmentDurations: vi.fn().mockResolvedValue([]),
  readHlsSentinel: vi.fn().mockResolvedValue(null),
  acquireProxyChunkLocally: vi.fn(),
  ensureAllProxyChunksInBackground: vi.fn(),
  ensureGameProxyInBackground: vi.fn(),
  cancelHighlightGeneration: cancelHighlightGenerationMock,
  cancelProxyBuild: cancelProxyBuildMock,
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
  getObjectEntityFileMock.mockClear();
  getObjectEntityFileMock.mockRejectedValue(
    new (class ObjectNotFoundError extends Error {
      constructor() { super("Not found"); this.name = "ObjectNotFoundError"; }
    })(),
  );
  cancelHighlightGenerationMock.mockClear();
  cancelProxyBuildMock.mockClear();
  lockedGameOverride.value = null;
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
  it("retains the video master and deletes the highlight derivative", async () => {
    findFirstMock.mockResolvedValueOnce({
      id: 42,
      ownerId: COACH_A.id,
      videoObjectPath: "/objects/uploads/1/video.mp4",
      highlightObjectPath: "/objects/uploads/1/highlight.mp4",
      lowlightObjectPath: null,
      videoProxyObjectPath: null,
    });

    const res = await deleteGame(42);
    expect(res.status).toBe(204);

    expect(deleteObjectEntityMock).not.toHaveBeenCalledWith("/objects/uploads/1/video.mp4");
    expect(deleteObjectEntityMock).toHaveBeenCalledWith("/objects/uploads/1/highlight.mp4");
  });

  it("also deletes lowlight and proxy paths when set", async () => {
    findFirstMock.mockResolvedValueOnce({
      id: 50,
      ownerId: COACH_A.id,
      videoObjectPath: "/objects/uploads/1/video.mp4",
      highlightObjectPath: "/objects/uploads/1/highlight.mp4",
      lowlightObjectPath: "/objects/uploads/1/lowlight.mp4",
      videoProxyObjectPath: "/objects/uploads/1/proxy.mp4",
    });

    const res = await deleteGame(50);
    expect(res.status).toBe(204);

    expect(deleteObjectEntityMock).not.toHaveBeenCalledWith("/objects/uploads/1/video.mp4");
    expect(deleteObjectEntityMock).toHaveBeenCalledWith("/objects/uploads/1/highlight.mp4");
    expect(deleteObjectEntityMock).toHaveBeenCalledWith("/objects/uploads/1/lowlight.mp4");
    expect(deleteObjectEntityMock).toHaveBeenCalledWith("/objects/uploads/1/proxy.mp4");
  });

  it("deletes every published standalone highlight clip for the game", async () => {
    const clip0 =
      "/objects/uploads/1/highlight_clips/54/00000000-0000-4000-8000-000000000001/clip_0.mp4";
    const clip1 =
      "/objects/uploads/1/highlight_clips/54/00000000-0000-4000-8000-000000000001/clip_1.mp4";
    findFirstMock.mockResolvedValueOnce({
      id: 54,
      ownerId: COACH_A.id,
      videoObjectPath: null,
      highlightObjectPath: null,
      highlightClipManifest: [
        { index: 0, durationMs: 1000, objectPath: clip0 },
        { index: 1, durationMs: 2000, objectPath: clip1 },
      ],
      lowlightObjectPath: null,
      videoProxyObjectPath: null,
    });

    const res = await deleteGame(54);
    expect(res.status).toBe(204);
    expect(deleteObjectEntityMock).toHaveBeenCalledWith(clip0);
    expect(deleteObjectEntityMock).toHaveBeenCalledWith(clip1);
  });

  it("captures a Highlight publication that races the initial read and DELETE lock", async () => {
    const staleCombined = "/objects/uploads/1/stale-highlight.mp4";
    const publishedCombined = "/objects/uploads/1/published-after-read.mp4";
    const publishedClip =
      "/objects/uploads/1/highlight_clips/55/new-run/clip_0.mp4";
    findFirstMock.mockResolvedValueOnce({
      id: 55,
      ownerId: COACH_A.id,
      videoObjectPath: null,
      highlightObjectPath: staleCombined,
      highlightClipManifest: null,
      lowlightObjectPath: null,
      videoProxyObjectPath: null,
    });
    // Deterministically represent a cross-instance worker committing after the
    // route's first owner check but before SELECT ... FOR UPDATE.
    lockedGameOverride.value = {
      id: 55,
      ownerId: COACH_A.id,
      videoObjectPath: null,
      highlightObjectPath: publishedCombined,
      highlightClipManifest: [
        { index: 0, durationMs: 1200, objectPath: publishedClip },
      ],
      highlightStatus: "ready",
      highlightGeneratorVersion: 12,
      lowlightObjectPath: null,
      videoProxyObjectPath: null,
    };

    const res = await deleteGame(55);
    expect(res.status).toBe(204);
    expect(deleteObjectEntityMock).toHaveBeenCalledWith(publishedCombined);
    expect(deleteObjectEntityMock).toHaveBeenCalledWith(publishedClip);
    expect(deleteObjectEntityMock).not.toHaveBeenCalledWith(staleCombined);
  });

  it("calls cancelHighlightGeneration and cancelProxyBuild before deleting", async () => {
    findFirstMock.mockResolvedValueOnce({
      id: 51,
      ownerId: COACH_A.id,
      videoObjectPath: "/objects/uploads/1/video.mp4",
      highlightObjectPath: null,
      lowlightObjectPath: null,
      videoProxyObjectPath: null,
    });

    const res = await deleteGame(51);
    expect(res.status).toBe(204);

    expect(cancelHighlightGenerationMock).toHaveBeenCalledWith(51);
    expect(cancelProxyBuildMock).toHaveBeenCalledWith(51);
  });

  it("does not call cancelHighlightGeneration when the game row is not found", async () => {
    findFirstMock.mockResolvedValueOnce(undefined);

    const res = await deleteGame(999);
    expect(res.status).toBe(204);
    expect(cancelHighlightGenerationMock).not.toHaveBeenCalled();
    expect(cancelProxyBuildMock).not.toHaveBeenCalled();
  });

  it("sweeps and deletes proxy chunks when they exist in GCS", async () => {
    findFirstMock.mockResolvedValueOnce({
      id: 52,
      ownerId: COACH_A.id,
      videoObjectPath: "/objects/uploads/1/video.mp4",
      highlightObjectPath: null,
      lowlightObjectPath: null,
      videoProxyObjectPath: null,
    });

    // Simulate chunk 0 and chunk 1 existing; chunk 2 is missing (throws).
    const chunk0Path = `/objects/uploads/${COACH_A.id}/proxy_chunk_vv5_52_0`;
    const chunk1Path = `/objects/uploads/${COACH_A.id}/proxy_chunk_vv5_52_1`;
    const mockFileWithSize = { getMetadata: vi.fn().mockResolvedValue([{ size: 50_000 }]) };

    getObjectEntityFileMock.mockImplementation(async (objectPath: string) => {
      if (objectPath === chunk0Path || objectPath === chunk1Path) return mockFileWithSize;
      throw new Error("Not found");
    });

    const res = await deleteGame(52);
    expect(res.status).toBe(204);

    expect(deleteObjectEntityMock).toHaveBeenCalledWith(chunk0Path);
    expect(deleteObjectEntityMock).toHaveBeenCalledWith(chunk1Path);
    // Chunk 2 was never found so should not be deleted.
    expect(deleteObjectEntityMock).not.toHaveBeenCalledWith(
      `/objects/uploads/${COACH_A.id}/proxy_chunk_vv5_52_2`,
    );
  });

  it("does not attempt chunk deletion when no chunks exist", async () => {
    findFirstMock.mockResolvedValueOnce({
      id: 53,
      ownerId: COACH_A.id,
      videoObjectPath: "/objects/uploads/1/video.mp4",
      highlightObjectPath: null,
      lowlightObjectPath: null,
      videoProxyObjectPath: null,
    });
    // getObjectEntityFileMock already rejects by default → sweep exits immediately.

    const res = await deleteGame(53);
    expect(res.status).toBe(204);
    // Best-effort HLS sentinel cleanup; no chunk paths or master deletion.
    expect(deleteObjectEntityMock).toHaveBeenCalledTimes(1);
    expect(deleteObjectEntityMock).not.toHaveBeenCalledWith("/objects/uploads/1/video.mp4");
    expect(deleteObjectEntityMock).toHaveBeenCalledWith("/hls-sentinel/53");
  });

  it("does not delete a video-only master when no derivative path is present", async () => {
    findFirstMock.mockResolvedValueOnce({
      id: 43,
      ownerId: COACH_A.id,
      videoObjectPath: "/objects/uploads/1/video-only.mp4",
      highlightObjectPath: null,
      lowlightObjectPath: null,
      videoProxyObjectPath: null,
    });

    const res = await deleteGame(43);
    expect(res.status).toBe(204);

    expect(deleteObjectEntityMock).toHaveBeenCalledTimes(1);
    expect(deleteObjectEntityMock).not.toHaveBeenCalledWith("/objects/uploads/1/video-only.mp4");
    expect(deleteObjectEntityMock).toHaveBeenCalledWith("/hls-sentinel/43");
  });

  it("does not call deleteObjectEntity when all paths are null", async () => {
    findFirstMock.mockResolvedValueOnce({
      id: 44,
      ownerId: COACH_A.id,
      videoObjectPath: null,
      highlightObjectPath: null,
      lowlightObjectPath: null,
      videoProxyObjectPath: null,
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

  it("normalizes a legacy absolute GCS URL before retaining it", async () => {
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
      lowlightObjectPath: null,
      videoProxyObjectPath: null,
    });

    const res = await deleteGame(45);
    expect(res.status).toBe(204);

    expect(normalizePathMock).toHaveBeenCalledWith(legacyUrl);
    expect(deleteObjectEntityMock).not.toHaveBeenCalledWith(normalizedPath);
  });

  it("still returns 204 when derivative cleanup throws (best-effort cleanup)", async () => {
    findFirstMock.mockResolvedValueOnce({
      id: 46,
      ownerId: COACH_A.id,
      videoObjectPath: "/objects/uploads/1/master.mp4",
      highlightObjectPath: "/objects/uploads/1/fail-highlight.mp4",
      lowlightObjectPath: null,
      videoProxyObjectPath: null,
    });

    deleteObjectEntityMock.mockRejectedValueOnce(new Error("GCS timeout"));

    const res = await deleteGame(46);
    expect(res.status).toBe(204);
  });
});
