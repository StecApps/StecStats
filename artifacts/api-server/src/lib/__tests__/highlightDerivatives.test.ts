import { beforeEach, describe, expect, it, vi } from "vitest";

const { deleteMock, deletePrefixMock, downloadMock, warnMock } = vi.hoisted(() => ({
  deleteMock: vi.fn(),
  deletePrefixMock: vi.fn(),
  downloadMock: vi.fn(),
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
    lowlightObjectPath: "lowlight_object_path",
    lowlightStatus: "lowlight_status",
    lowlightGeneratorVersion: "lowlight_generator_version",
  },
}));

vi.mock("../objectStorage", () => ({
  ObjectStorageService: class {
    normalizeObjectEntityPath(path: string) { return path; }
    deleteObjectEntity = deleteMock;
    deleteObjectEntityPrefix = deletePrefixMock;
    getObjectEntityFile = vi.fn().mockResolvedValue({ download: downloadMock });
  },
}));

vi.mock("../logger", () => ({
  logger: { warn: warnMock },
}));

import {
  captureAndInvalidateHighlight,
  cleanupCapturedHighlightDerivatives,
  cleanupReelHlsDerivative,
  readReelHlsManifest,
  reelHlsManifestPath,
  reelHlsSegmentPath,
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
    deletePrefixMock.mockReset().mockResolvedValue(undefined);
    downloadMock.mockReset();
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
    expect(deletePrefixMock).toHaveBeenCalledWith(`${publishedPath}.hls`);
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

describe("stored reel HLS derivatives", () => {
  beforeEach(() => {
    downloadMock.mockReset();
    deletePrefixMock.mockReset().mockResolvedValue(undefined);
  });

  it("accepts only a manifest bound to the exact combined reel path", async () => {
    const combinedPath = "/objects/uploads/7/reel.mp4";
    downloadMock.mockResolvedValue([Buffer.from(JSON.stringify({
      version: 1,
      segmentDurationSec: 4,
      durationMs: 7_500,
      segments: [
        { objectPath: reelHlsSegmentPath(combinedPath, 0), durationSec: 4 },
        { objectPath: reelHlsSegmentPath(combinedPath, 1), durationSec: 3.5 },
      ],
    }))]);

    await expect(readReelHlsManifest(combinedPath)).resolves.toMatchObject({
      durationMs: 7_500,
      segments: [{ durationSec: 4 }, { durationSec: 3.5 }],
    });
    expect(reelHlsManifestPath(combinedPath)).toBe(`${combinedPath}.hls/manifest.json`);
  });

  it("rejects a manifest that points at another reel's segments", async () => {
    downloadMock.mockResolvedValue([Buffer.from(JSON.stringify({
      version: 1,
      segmentDurationSec: 4,
      durationMs: 4_000,
      segments: [{ objectPath: "/objects/uploads/8/other.mp4.hls/segment-0.ts", durationSec: 4 }],
    }))]);
    await expect(readReelHlsManifest("/objects/uploads/7/reel.mp4")).resolves.toBeNull();
  });

  it("deletes only the sidecar namespace for the matching combined reel", async () => {
    await cleanupReelHlsDerivative("/objects/uploads/7/reel.mp4");
    expect(deletePrefixMock).toHaveBeenCalledWith("/objects/uploads/7/reel.mp4.hls");
  });
});