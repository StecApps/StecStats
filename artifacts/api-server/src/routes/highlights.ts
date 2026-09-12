import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, gamesTable } from "@workspace/db";
import { GetGameParams, GetGameHighlightResponse } from "@workspace/api-zod";
import {
  countEligibleMoments,
  getHighlightCoverage,
  generateHighlight,
  cancelHighlightJob,
  cancelHighlightRun,
  GENERATOR_VERSION,
} from "../lib/highlightGenerator";
import { scheduleVideoDurationProbe } from "../lib/videoDuration";
import { requireAuth } from "../middlewares/requireAuth";
import { ObjectStorageService } from "../lib/objectStorage";
import {
  captureAndInvalidateHighlight,
  cleanupCapturedHighlightDerivatives,
} from "../lib/highlightDerivatives";
import { getEntitlementsForUser, getEntitlements, isPro } from "../lib/entitlements";
import { getMusicTrackPath } from "../lib/musicTracks";
import {
  launchReelJob,
  resumeReelJob,
} from "../lib/reelLease";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

type StoredHighlightClip = { index: number; durationMs: number; objectPath: string };

function publishedClips(
  value: unknown,
  ownerId?: number,
  gameId?: number,
): StoredHighlightClip[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((clip): clip is StoredHighlightClip =>
      typeof clip === "object"
      && clip !== null
      && Number.isInteger((clip as StoredHighlightClip).index)
      && (clip as StoredHighlightClip).index >= 0
      && Number.isInteger((clip as StoredHighlightClip).durationMs)
      && (clip as StoredHighlightClip).durationMs > 0
      && typeof (clip as StoredHighlightClip).objectPath === "string"
      && (
        ownerId == null
        || gameId == null
        || (clip as StoredHighlightClip).objectPath.startsWith(
          `/objects/uploads/${ownerId}/highlight_clips/${gameId}/`,
        )
      ),
    )
    .sort((a, b) => a.index - b.index);
}

const highlightRunner = {
  generate: generateHighlight,
  cancelRun: cancelHighlightRun,
};

function normalizeStatus(raw: string | null): "idle" | "queued" | "processing" | "ready" | "failed" {
  if (raw === "queued" || raw === "processing" || raw === "ready" || raw === "failed") return raw;
  return "idle";
}

router.get("/games/:gameId/highlight", requireAuth, async (req, res) => {
  const { gameId } = GetGameParams.parse(req.params);
  const game = await db.query.gamesTable.findFirst({
    where: and(eq(gamesTable.id, gameId), eq(gamesTable.ownerId, req.appUser!.id)),
  });
  if (!game) {
    res.status(404).json({ error: "Game not found" });
    return;
  }

  let highlightStatus = game.highlightStatus;
  let highlightError = game.highlightError;

  // Invalidate reels built by older clip-timing code. Reset to idle so the
  // UI shows a fresh Generate button — the user triggers the rebuild manually.
  let highlightObjectPath = game.highlightObjectPath;
  let highlightStartedAt = game.highlightStartedAt;
  let highlightPlaybackVersion = game.highlightPlaybackVersion;
  let progressStage = game.highlightProgressStage;
  let progressCompleted = game.highlightProgressCompleted;
  let progressTotal = game.highlightProgressTotal;
  if (
    highlightStatus === "ready" &&
    (game.highlightGeneratorVersion ?? 0) < GENERATOR_VERSION
  ) {
    const captured = await db.transaction((tx) =>
      captureAndInvalidateHighlight(
        tx,
        gameId,
        req.appUser!.id,
        (current) =>
          current.highlightStatus === "ready"
          && (current.highlightGeneratorVersion ?? 0) < GENERATOR_VERSION,
      ),
    );
    if (captured) {
      await cleanupCapturedHighlightDerivatives(captured);
      highlightStatus = null;
      highlightError = null;
      highlightObjectPath = null;
      highlightStartedAt = null;
      highlightPlaybackVersion = null;
      progressStage = null;
      progressCompleted = null;
      progressTotal = null;
    }
  }

  // Legacy games may predate duration probing — self-heal lazily.
  if (game.videoObjectPath && game.videoDurationMs == null) {
    scheduleVideoDurationProbe(gameId, game.videoObjectPath);
  }

  const { eligibleMoments, onFilmMoments } = await getHighlightCoverage(game);
  const clips = highlightStatus === "ready"
    ? await Promise.all(publishedClips(
        game.highlightClipManifest,
        req.appUser!.id,
        gameId,
      ).map(async (clip) => ({
        index: clip.index,
        durationMs: clip.durationMs,
        streamUrl: await objectStorageService.getObjectEntitySignedURL(clip.objectPath, 3600),
      })))
    : [];
  // Prevent the deployment edge from caching this response. Without this the
  // processing→ready transition is invisible: the client keeps getting 304
  // with the stale "processing" body until the CDN cache expires.
  res.setHeader("Cache-Control", "no-store");
  res.json(
    GetGameHighlightResponse.parse({
      status: normalizeStatus(highlightStatus),
      highlightObjectPath: highlightObjectPath ?? null,
      error: highlightError ?? null,
      startedAt: highlightStartedAt?.toISOString() ?? null,
      progressStage: progressStage ?? null,
      progressCompleted: progressCompleted ?? null,
      progressTotal: progressTotal ?? null,
      eligibleMoments,
      onFilmMoments,
      musicTrack: game.highlightMusicTrack ?? null,
      youtubeUrl: game.highlightYoutubeUrl ?? null,
      playbackVersion: highlightPlaybackVersion ?? null,
      clips,
    }),
  );
});

router.post("/games/:gameId/highlight", requireAuth, async (req, res) => {
  const { gameId } = GetGameParams.parse(req.params);
  const game = await db.query.gamesTable.findFirst({
    where: and(eq(gamesTable.id, gameId), eq(gamesTable.ownerId, req.appUser!.id)),
  });
  if (!game) {
    res.status(404).json({ error: "Game not found" });
    return;
  }

  const entitlements = await getEntitlementsForUser(req.appUser!);
  if (!isPro(entitlements)) {
    res.status(403).json({ error: "UPGRADE_REQUIRED", message: "Game highlight reels are a Pro feature" });
    return;
  }

  if (!game.videoObjectPath) {
    res.status(400).json({ error: "This game has no recorded video to build a reel from" });
    return;
  }

  const eligibleMoments = await countEligibleMoments(gameId);
  if (eligibleMoments === 0) {
    res.status(400).json({
      error: "No highlight-worthy moments were tagged in this game",
    });
    return;
  }

  // Optional background music — validate the track ID server-side.
  const musicTrackId = typeof req.body?.musicTrack === "string" ? req.body.musicTrack : undefined;
  const musicTrackPath = musicTrackId ? getMusicTrackPath(musicTrackId) : undefined;

  let startedAt = game.highlightStartedAt;
  let currentProgressStage = game.highlightProgressStage;
  let currentProgressCompleted = game.highlightProgressCompleted;
  let currentProgressTotal = game.highlightProgressTotal;
  const captured = await db.transaction((tx) =>
    captureAndInvalidateHighlight(
      tx,
      gameId,
      req.appUser!.id,
      (current) =>
        current.highlightStatus !== "queued"
        && current.highlightStatus !== "processing",
    ),
  );
  await cleanupCapturedHighlightDerivatives(captured);
  const lease = await launchReelJob(
    gameId,
    "highlight",
    {
      highlightError: null,
      highlightMusicTrack: musicTrackId ?? null,
      highlightNotificationSent: false,
      highlightProgressStage: null,
      highlightProgressCompleted: null,
      highlightProgressTotal: null,
    },
    musicTrackPath ?? undefined,
    highlightRunner,
  );
  let responseStatus: "idle" | "queued" | "processing" | "ready" | "failed";
  if (lease) {
    startedAt = lease.startedAt;
    responseStatus = "queued";
  } else {
    // A concurrent request or another autoscaled instance may have won the
    // lease after this request read `game`. Return the winner's current phase,
    // not the stale pre-claim status, so the client keeps polling accurately.
    const current = await db.query.gamesTable.findFirst({
      where: and(eq(gamesTable.id, gameId), eq(gamesTable.ownerId, req.appUser!.id)),
    });
    responseStatus = normalizeStatus(current?.highlightStatus ?? game.highlightStatus);
    startedAt = current?.highlightStartedAt ?? game.highlightStartedAt;
    currentProgressStage = current?.highlightProgressStage ?? null;
    currentProgressCompleted = current?.highlightProgressCompleted ?? null;
    currentProgressTotal = current?.highlightProgressTotal ?? null;
  }

  res.status(202).json(
    GetGameHighlightResponse.parse({
      status: responseStatus,
      highlightObjectPath: captured ? null : (game.highlightObjectPath ?? null),
      error: null,
      startedAt: startedAt?.toISOString() ?? null,
      progressStage: lease ? null : (currentProgressStage ?? null),
      progressCompleted: lease ? null : (currentProgressCompleted ?? null),
      progressTotal: lease ? null : (currentProgressTotal ?? null),
      eligibleMoments,
      musicTrack: musicTrackId ?? game.highlightMusicTrack ?? null,
      playbackVersion: null,
      clips: [],
    }),
  );
});

router.get("/games/:gameId/highlight/clips/:clipIndex", requireAuth, async (req, res) => {
  const { gameId } = GetGameParams.parse(req.params);
  const clipIndex = Number(req.params["clipIndex"]);
  if (!Number.isSafeInteger(clipIndex) || clipIndex < 0) {
    res.status(404).json({ error: "Highlight clip not found" });
    return;
  }
  const game = await db.query.gamesTable.findFirst({
    where: and(eq(gamesTable.id, gameId), eq(gamesTable.ownerId, req.appUser!.id)),
  });
  const clip = game?.highlightStatus === "ready"
    ? publishedClips(
        game.highlightClipManifest,
        req.appUser!.id,
        gameId,
      ).find((entry) => entry.index === clipIndex)
    : undefined;
  if (!clip) {
    res.status(404).json({ error: "Highlight clip not found" });
    return;
  }
  const signedUrl = await objectStorageService.getObjectEntitySignedURL(clip.objectPath, 3600);
  res.redirect(302, signedUrl);
});

/**
 * Atomically claim and re-trigger a highlight job whose database lease expired.
 * Called at startup for queued or processing games with no current owner.
 */
export async function resumeHighlightJob(gameId: number): Promise<void> {
  await resumeReelJob(gameId, "highlight", highlightRunner);
}

router.delete("/games/:gameId/highlight", requireAuth, async (req, res) => {
  const { gameId } = GetGameParams.parse(req.params);
  const game = await db.query.gamesTable.findFirst({
    where: and(eq(gamesTable.id, gameId), eq(gamesTable.ownerId, req.appUser!.id)),
  });
  if (!game) { res.status(404).json({ error: "Game not found" }); return; }

  // Use "failed" (not null) so the status is never "processing" at the
  // moment of an OOM kill — the auto-resume query only picks up
  // "processing" games, so "failed" breaks the infinite restart loop.
  cancelHighlightJob(gameId);
  const captured = await db.transaction((tx) =>
    captureAndInvalidateHighlight(
      tx,
      gameId,
      req.appUser!.id,
      () => true,
      {
        highlightStatus: "failed",
        highlightError: "Generation was cancelled",
        highlightStartedAt: null,
        highlightProgressStage: null,
        highlightProgressCompleted: null,
        highlightProgressTotal: null,
      },
    ),
  );
  await cleanupCapturedHighlightDerivatives(captured);

  res.json({ ok: true });
});

export default router;
