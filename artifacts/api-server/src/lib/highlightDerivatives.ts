import { and, eq } from "drizzle-orm";
import { db, gamesTable } from "@workspace/db";
import { logger } from "./logger";
import { ObjectStorageService } from "./objectStorage";

type GameTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface CapturedHighlightDerivatives {
  gameId: number;
  ownerId: number;
  combinedPath: string | null;
  clipPaths: string[];
}

export interface CapturedLowlightDerivatives {
  gameId: number;
  ownerId: number;
  combinedPath: string | null;
}

export interface ReelHlsManifest {
  version: 1;
  segmentDurationSec: number;
  durationMs: number;
  segments: Array<{ objectPath: string; durationSec: number }>;
}

export function reelHlsPrefix(combinedPath: string): string {
  return `${combinedPath}.hls`;
}

export function reelHlsManifestPath(combinedPath: string): string {
  return `${reelHlsPrefix(combinedPath)}/manifest.json`;
}

export function reelHlsSegmentPath(combinedPath: string, index: number): string {
  return `${reelHlsPrefix(combinedPath)}/segment-${index}.ts`;
}

export async function readReelHlsManifest(
  combinedPath: string,
): Promise<ReelHlsManifest | null> {
  const storage = new ObjectStorageService();
  try {
    const file = await storage.getObjectEntityFile(reelHlsManifestPath(combinedPath));
    const [contents] = await file.download();
    const parsed = JSON.parse(contents.toString("utf8")) as ReelHlsManifest;
    if (
      parsed.version !== 1
      || !Number.isFinite(parsed.durationMs)
      || parsed.durationMs <= 0
      || !Number.isFinite(parsed.segmentDurationSec)
      || parsed.segmentDurationSec <= 0
      || !Array.isArray(parsed.segments)
      || parsed.segments.length < 1
      || parsed.segments.some((segment, index) =>
        segment.objectPath !== reelHlsSegmentPath(combinedPath, index)
        || !Number.isFinite(segment.durationSec)
        || segment.durationSec <= 0)
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function cleanupReelHlsDerivative(combinedPath: string): Promise<void> {
  const storage = new ObjectStorageService();
  await storage.deleteObjectEntityPrefix(reelHlsPrefix(combinedPath));
}

export const highlightDerivativeInvalidation = {
  highlightObjectPath: null,
  highlightClipManifest: null,
  highlightPlaybackVersion: null,
  highlightStatus: "idle",
  highlightError: null,
  highlightStartedAt: null,
  highlightProgressStage: null,
  highlightProgressCompleted: null,
  highlightProgressTotal: null,
  highlightGeneratorVersion: null,
  highlightRunToken: null,
  highlightLeaseExpiresAt: null,
} as const;

function validatedClipPaths(manifest: unknown, ownerId: number, gameId: number): string[] {
  if (!Array.isArray(manifest)) return [];
  const prefix = `/objects/uploads/${ownerId}/highlight_clips/${gameId}/`;
  return manifest.flatMap((clip) => {
    const objectPath = typeof clip === "object" && clip !== null
      ? (clip as { objectPath?: unknown }).objectPath
      : undefined;
    return typeof objectPath === "string" && objectPath.startsWith(prefix)
      ? [objectPath]
      : [];
  });
}

/**
 * Locks the owner-scoped game row, captures the exact currently published
 * derivatives, then fences and clears Highlight state in the same transaction.
 * A publisher racing this operation either commits before the lock (and is
 * captured) or waits until after the token is cleared (and its fenced update
 * fails).
 */
export async function captureAndInvalidateHighlight(
  tx: GameTransaction,
  gameId: number,
  ownerId: number,
  shouldInvalidate: (row: {
    highlightStatus: string | null;
    highlightGeneratorVersion: number | null;
  }) => boolean = () => true,
  values: Record<string, unknown> = {},
): Promise<CapturedHighlightDerivatives | null> {
  const [current] = await tx
    .select({
      highlightObjectPath: gamesTable.highlightObjectPath,
      highlightClipManifest: gamesTable.highlightClipManifest,
      highlightStatus: gamesTable.highlightStatus,
      highlightGeneratorVersion: gamesTable.highlightGeneratorVersion,
    })
    .from(gamesTable)
    .where(and(eq(gamesTable.id, gameId), eq(gamesTable.ownerId, ownerId)))
    .for("update");
  if (!current || !shouldInvalidate(current)) return null;

  await tx
    .update(gamesTable)
    .set({ ...highlightDerivativeInvalidation, ...values })
    .where(and(eq(gamesTable.id, gameId), eq(gamesTable.ownerId, ownerId)));

  return {
    gameId,
    ownerId,
    combinedPath: current.highlightObjectPath,
    clipPaths: validatedClipPaths(current.highlightClipManifest, ownerId, gameId),
  };
}

export async function captureAndInvalidateLowlight(
  tx: GameTransaction,
  gameId: number,
  ownerId: number,
  shouldInvalidate: (row: {
    lowlightStatus: string | null;
    lowlightGeneratorVersion: number | null;
  }) => boolean = () => true,
  values: Record<string, unknown> = {},
): Promise<CapturedLowlightDerivatives | null> {
  const [current] = await tx
    .select({
      lowlightObjectPath: gamesTable.lowlightObjectPath,
      lowlightStatus: gamesTable.lowlightStatus,
      lowlightGeneratorVersion: gamesTable.lowlightGeneratorVersion,
    })
    .from(gamesTable)
    .where(and(eq(gamesTable.id, gameId), eq(gamesTable.ownerId, ownerId)))
    .for("update");
  if (!current || !shouldInvalidate(current)) return null;

  await tx
    .update(gamesTable)
    .set({
      lowlightObjectPath: null,
      lowlightStatus: "idle",
      lowlightError: null,
      lowlightStartedAt: null,
      lowlightProgressStage: null,
      lowlightProgressCompleted: null,
      lowlightProgressTotal: null,
      lowlightGeneratorVersion: null,
      lowlightRunToken: null,
      lowlightLeaseExpiresAt: null,
      ...values,
    })
    .where(and(eq(gamesTable.id, gameId), eq(gamesTable.ownerId, ownerId)));

  return { gameId, ownerId, combinedPath: current.lowlightObjectPath };
}

export async function cleanupCapturedLowlightDerivatives(
  captured: CapturedLowlightDerivatives | null | undefined,
): Promise<void> {
  if (!captured?.combinedPath) return;
  const storage = new ObjectStorageService();
  try {
    await cleanupReelHlsDerivative(captured.combinedPath);
    await storage.deleteObjectEntity(storage.normalizeObjectEntityPath(captured.combinedPath));
  } catch (err) {
    logger.warn(
      { err, gameId: captured.gameId, objectPath: captured.combinedPath },
      "Lowlight derivative cleanup failed; object left for namespace cleanup",
    );
  }
}

/**
 * DB state is already committed when this runs. Cleanup is deliberately
 * best-effort: failures are logged for namespace/orphan sweeps and never turn a
 * successful invalidation into a misleading failed HTTP response.
 */
export async function cleanupCapturedHighlightDerivatives(
  captured: CapturedHighlightDerivatives | null | undefined,
): Promise<void> {
  if (!captured) return;
  const storage = new ObjectStorageService();
  const paths = [
    ...(captured.combinedPath ? [storage.normalizeObjectEntityPath(captured.combinedPath)] : []),
    ...captured.clipPaths,
  ];
  await Promise.all(paths.map(async (objectPath) => {
    await cleanupReelHlsDerivative(objectPath).catch((err) => {
      logger.warn(
        { err, gameId: captured.gameId, objectPath },
        "Highlight HLS cleanup failed; objects left for namespace cleanup",
      );
    });
    try {
      await storage.deleteObjectEntity(objectPath);
    } catch (err) {
      logger.warn(
        { err, gameId: captured.gameId, objectPath },
        "Highlight derivative cleanup failed; object left for namespace cleanup",
      );
    }
  }));
}