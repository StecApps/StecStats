import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, gamesTable } from "@workspace/db";
import { GetGameParams } from "@workspace/api-zod";
import {
  countLowlightMoments,
  getLowlightCoverage,
  generateLowlight,
  cancelLowlightJob,
  cancelLowlightRun,
  GENERATOR_VERSION,
} from "../lib/highlightGenerator";
import { scheduleVideoDurationProbe } from "../lib/videoDuration";
import { requireAuth } from "../middlewares/requireAuth";
import { getEntitlementsForUser, getEntitlements, isPro } from "../lib/entitlements";
import { getMusicTrackPath } from "../lib/musicTracks";
import {
  launchReelJob,
  resumeReelJob,
} from "../lib/reelLease";
import {
  captureAndInvalidateLowlight,
  cleanupCapturedLowlightDerivatives,
} from "../lib/highlightDerivatives";

const router: IRouter = Router();

const lowlightRunner = {
  generate: generateLowlight,
  cancelRun: cancelLowlightRun,
};
function normalizeStatus(raw: string | null): "idle" | "queued" | "processing" | "ready" | "failed" {
  if (raw === "queued" || raw === "processing" || raw === "ready" || raw === "failed") return raw;
  return "idle";
}

router.get("/games/:gameId/lowlight", requireAuth, async (req, res) => {
  const { gameId } = GetGameParams.parse(req.params);
  const game = await db.query.gamesTable.findFirst({
    where: and(eq(gamesTable.id, gameId), eq(gamesTable.ownerId, req.appUser!.id)),
  });
  if (!game) { res.status(404).json({ error: "Game not found" }); return; }

  let lowlightStatus = game.lowlightStatus;
  let lowlightError = game.lowlightError;

  // Invalidate reels built by older clip-timing code. Reset to idle so the
  // UI shows a fresh Generate button — the user triggers the rebuild manually.
  let lowlightObjectPath = game.lowlightObjectPath;
  let lowlightStartedAt = game.lowlightStartedAt;
  let progressStage = game.lowlightProgressStage;
  let progressCompleted = game.lowlightProgressCompleted;
  let progressTotal = game.lowlightProgressTotal;
  if (
    lowlightStatus === "ready" &&
    (game.lowlightGeneratorVersion ?? 0) < GENERATOR_VERSION
  ) {
    const captured = await db.transaction((tx) =>
      captureAndInvalidateLowlight(
        tx,
        gameId,
        req.appUser!.id,
        (current) =>
          current.lowlightStatus === "ready"
          && (current.lowlightGeneratorVersion ?? 0) < GENERATOR_VERSION,
      ),
    );
    if (captured) {
      await cleanupCapturedLowlightDerivatives(captured);
      lowlightStatus = null;
      lowlightError = null;
      lowlightObjectPath = null;
      lowlightStartedAt = null;
      progressStage = null;
      progressCompleted = null;
      progressTotal = null;
    }
  }

  // Legacy games may predate duration probing — self-heal lazily.
  if (game.videoObjectPath && game.videoDurationMs == null) {
    scheduleVideoDurationProbe(gameId, game.videoObjectPath);
  }

  const { eligibleMoments, onFilmMoments } = await getLowlightCoverage(game);
  // Match the highlight status endpoint: generated-media state must never be
  // served from the deployment edge cache or mobile can keep seeing an old
  // ready/processing response after invalidation or regeneration.
  res.setHeader("Cache-Control", "no-store");
  res.json({
    status: normalizeStatus(lowlightStatus),
    lowlightObjectPath: lowlightObjectPath ?? null,
    error: lowlightError ?? null,
    startedAt: lowlightStartedAt?.toISOString() ?? null,
    progressStage: progressStage ?? null,
    progressCompleted: progressCompleted ?? null,
    progressTotal: progressTotal ?? null,
    eligibleMoments,
    onFilmMoments,
    musicTrack: game.lowlightMusicTrack ?? null,
  });
});

router.post("/games/:gameId/lowlight", requireAuth, async (req, res) => {
  const { gameId } = GetGameParams.parse(req.params);
  const game = await db.query.gamesTable.findFirst({
    where: and(eq(gamesTable.id, gameId), eq(gamesTable.ownerId, req.appUser!.id)),
  });
  if (!game) { res.status(404).json({ error: "Game not found" }); return; }

  const entitlements = await getEntitlementsForUser(req.appUser!);
  if (!isPro(entitlements)) {
    res.status(403).json({ error: "UPGRADE_REQUIRED", message: "Lowlight reels are a Pro feature" });
    return;
  }

  if (!game.videoObjectPath) {
    res.status(400).json({ error: "This game has no recorded video to build a reel from" });
    return;
  }

  const eligibleMoments = await countLowlightMoments(gameId);
  if (eligibleMoments === 0) {
    res.status(400).json({ error: "No lowlight moments (missed shots/turnovers) were tagged in this game" });
    return;
  }

  // Optional background music — validate the track ID server-side.
  const musicTrackId = typeof req.body?.musicTrack === "string" ? req.body.musicTrack : undefined;
  const musicTrackPath = musicTrackId ? getMusicTrackPath(musicTrackId) : undefined;

  let startedAt = game.lowlightStartedAt;
  const captured = await db.transaction((tx) =>
    captureAndInvalidateLowlight(
      tx,
      gameId,
      req.appUser!.id,
      (current) =>
        current.lowlightStatus !== "queued"
        && current.lowlightStatus !== "processing",
    ),
  );
  await cleanupCapturedLowlightDerivatives(captured);
  const lease = await launchReelJob(
    gameId,
    "lowlight",
    {
      lowlightError: null,
      lowlightMusicTrack: musicTrackId ?? null,
      lowlightNotificationSent: false,
      lowlightProgressStage: null,
      lowlightProgressCompleted: null,
      lowlightProgressTotal: null,
    },
    musicTrackPath ?? undefined,
    lowlightRunner,
  );
  let responseStatus: "idle" | "queued" | "processing" | "ready" | "failed";
  let current = game;
  if (lease) {
    startedAt = lease.startedAt;
    responseStatus = "queued";
  } else {
    current = await db.query.gamesTable.findFirst({
      where: and(eq(gamesTable.id, gameId), eq(gamesTable.ownerId, req.appUser!.id)),
    }) ?? game;
    responseStatus = normalizeStatus(current.lowlightStatus);
    startedAt = current.lowlightStartedAt;
  }

  res.status(202).json({
    status: responseStatus,
    lowlightObjectPath: game.lowlightObjectPath ?? null,
    error: null,
    startedAt: startedAt?.toISOString() ?? null,
    progressStage: lease ? null : (current.lowlightProgressStage ?? null),
    progressCompleted: lease ? null : (current.lowlightProgressCompleted ?? null),
    progressTotal: lease ? null : (current.lowlightProgressTotal ?? null),
    eligibleMoments,
    musicTrack: musicTrackId ?? game.lowlightMusicTrack ?? null,
  });
});

/**
 * Atomically claim and re-trigger a lowlight job whose database lease expired.
 */
export async function resumeLowlightJob(gameId: number): Promise<void> {
  await resumeReelJob(gameId, "lowlight", lowlightRunner);
}

router.delete("/games/:gameId/lowlight", requireAuth, async (req, res) => {
  const { gameId } = GetGameParams.parse(req.params);
  const game = await db.query.gamesTable.findFirst({
    where: and(eq(gamesTable.id, gameId), eq(gamesTable.ownerId, req.appUser!.id)),
  });
  if (!game) { res.status(404).json({ error: "Game not found" }); return; }

  cancelLowlightJob(gameId);
  const captured = await db.transaction((tx) =>
    captureAndInvalidateLowlight(tx, gameId, req.appUser!.id, () => true, {
      lowlightStatus: "failed",
      lowlightError: "Generation was cancelled",
    }),
  );
  await cleanupCapturedLowlightDerivatives(captured);

  res.json({ ok: true });
});

export default router;
