import { beforeEach, describe, expect, it, vi } from "vitest";

const { deleteMock, warnMock } = vi.hoisted(() => ({
  deleteMock: vi.fn(),
  warnMock: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  db: { transaction: vi.fn() },
  gamesTable: {
    id: "id",
    ownerId: "owner_id",
    highlightObjectPath: "highlight_object_path",
    highlightClipManifest: "highlight_clip_manifest",
    highlightStatus: "highlight_status",
    highlightGeneratorVersion: "highlight_generator_version",
  },
}));

vi.mock("../objectStorage", () => ({
  ObjectStorageService: class {
    normalizeObjectEntityPath(path: string) { return path; }
    deleteObjectEntity = deleteMock;
  },
}));

vi.mock("../logger", () => ({
  logger: { warn: warnMock },
}));

import {
  captureAndInvalidateHighlight,
  cleanupCapturedHighlightDerivatives,
} from "../highlightDerivatives";

function transactionFor(row: Record<string, unknown>) {
  const set = vi.fn().mockImplementation((values: Record<string, unknown>) => ({
    where: vi.fn().mockImplementation(async () => Object.assign(row, values)),
  }));
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          for: vi.fn().mockImplementation(async () => [{ ...row }]),
        }),
      }),
    }),
    update: vi.fn().mockReturnValue({ set }),
  };
}

describe("atomic Highlight derivative invalidation", () => {
  beforeEach(() => {
    deleteMock.mockReset().mockResolvedValue(undefined);
    warnMock.mockReset();
  });

  it("captures a publication that wins after the request snapshot but before the row lock", async () => {
    const requestSnapshotPath = "/objects/uploads/7/old.mp4";
    const publishedPath = "/objects/uploads/7/new.mp4";
    const publishedClip =
      "/objects/uploads/7/highlight_clips/42/new-run/clip_0.mp4";
    const row = {
      highlightObjectPath: publishedPath,
      highlightClipManifest: [
        { index: 0, durationMs: 1000, objectPath: publishedClip },
      ],
      highlightPlaybackVersion: 1,
      highlightStatus: "ready",
      highlightGeneratorVersion: 12,
      highlightRunToken: "new-run",
      highlightLeaseExpiresAt: new Date(),
    };

    // The route's earlier read saw requestSnapshotPath; the lock sees the
    // deterministic intervening publication represented by row.
    expect(requestSnapshotPath).not.toBe(row.highlightObjectPath);
    const captured = await captureAndInvalidateHighlight(
      transactionFor(row) as never,
      42,
      7,
    );

    expect(captured).toMatchObject({
      combinedPath: publishedPath,
      clipPaths: [publishedClip],
    });
    expect(row).toMatchObject({
      highlightObjectPath: null,
      highlightClipManifest: null,
      highlightRunToken: null,
      highlightLeaseExpiresAt: null,
      highlightStatus: "idle",
    });
    await cleanupCapturedHighlightDerivatives(captured);
    expect(deleteMock).toHaveBeenCalledWith(publishedPath);
    expect(deleteMock).toHaveBeenCalledWith(publishedClip);
    expect(deleteMock).not.toHaveBeenCalledWith(requestSnapshotPath);
  });

  it("logs post-commit cleanup errors without rejecting", async () => {
    deleteMock.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(cleanupCapturedHighlightDerivatives({
      gameId: 42,
      ownerId: 7,
      combinedPath: "/objects/uploads/7/reel.mp4",
      clipPaths: [],
    })).resolves.toBeUndefined();
    expect(warnMock).toHaveBeenCalled();
  });
});