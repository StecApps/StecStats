import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, gamesTable } from "@workspace/db";
import { GetGameParams, GetGameHighlightResponse } from "@workspace/api-zod";
import {
  countEligibleMoments,
  getHighlightCoverage,
  generateHighlight,
  cancelHighlightGeneration,
  GENERATOR_VERSION,
} from "../lib/highlightGenerator";
import { scheduleVideoDurationProbe } from "../lib/videoDuration";
import { requireAuth } from "../middlewares/requireAuth";
import { getEntitlements, isPro } from "../lib/entitlements";
import { getMusicTrackPath } from "../lib/musicTracks";

const router: IRouter = Router();

// Guards against launching a second generation while one is already running
// for the same game (survives concurrent requests within this process).
const inFlight = new Set<number>();

// Jobs not in-flight (e.g. server restarted) are stale after 5 minutes.
const STALE_PROCESSING_MS = 5 * 60 * 1000;
// Hard wall: even an in-flight job is considered abandoned after 30 minutes
// with no completion — guards against silent ffmpeg crashes where the process
// dies without updating the DB status.
const HARD_STALE_MS = 30 * 60 * 1000;

function normalizeStatus(raw: string | null): "idle" | "processing" | "ready" | "failed" {
  if (raw === "processing" || raw === "ready" || raw === "failed") return raw;
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

  // Detect stale "processing" — job was abandoned (e.g. server restarted mid-run).
  // Reset to "failed" so the client shows a retry button instead of a permanent spinner.
  let highlightStatus = game.highlightStatus;
  let highlightError = game.highlightError;
  const startedAtMs = game.highlightStartedAt ? new Date(game.highlightStartedAt).getTime() : 0;
  const elapsed = Date.now() - startedAtMs;
  const isStale =
    highlightStatus === "processing" &&
    (elapsed > HARD_STALE_MS || (!inFlight.has(gameId) && elapsed > STALE_PROCESSING_MS));
  if (isStale) {
    highlightStatus = "failed";
    highlightError = "Generation timed out — tap Try Again to rebuild.";
    await db
      .update(gamesTable)
      .set({ highlightStatus, highlightError })
      .where(eq(gamesTable.id, gameId));
  }

  // Invalidate reels built by older clip-timing code (e.g. clips that ended
  // before the play happened). Reset to idle so the UI offers a fresh
  // Generate button instead of forever serving the stale cached reel.
  let highlightObjectPath = game.highlightObjectPath;
  let highlightStartedAt = game.highlightStartedAt;
  if (
    highlightStatus === "ready" &&
    (game.highlightGeneratorVersion ?? 0) < GENERATOR_VERSION
  ) {
    highlightStatus = null;
    highlightError = null;
    highlightObjectPath = null;
    highlightStartedAt = null;
    await db
      .update(gamesTable)
      .set({
        highlightStatus: null,
        highlightError: null,
        highlightObjectPath: null,
        highlightStartedAt: null,
      })
      .where(eq(gamesTable.id, gameId));
  }

  // Legacy games may predate duration probing — self-heal lazily.
  if (game.videoObjectPath && game.videoDurationMs == null) {
    scheduleVideoDurationProbe(gameId, game.videoObjectPath);
  }

  const { eligibleMoments, onFilmMoments } = await getHighlightCoverage(game);
  res.json(
    GetGameHighlightResponse.parse({
      status: normalizeStatus(highlightStatus),
      highlightObjectPath: highlightObjectPath ?? null,
      error: highlightError ?? null,
      startedAt: isStale ? null : (highlightStartedAt?.toISOString() ?? null),
      eligibleMoments,
      onFilmMoments,
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

  const entitlements = await getEntitlements(req.appUser!.stripeCustomerId, req.appUser!.email);
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

  const startedAtMs = game.highlightStartedAt
    ? new Date(game.highlightStartedAt).getTime()
    : 0;
  const elapsedMs = Date.now() - startedAtMs;
  const staleProcessing =
    game.highlightStatus === "processing" &&
    (elapsedMs > HARD_STALE_MS || (!inFlight.has(gameId) && elapsedMs > STALE_PROCESSING_MS));
  const alreadyRunning =
    inFlight.has(gameId) || (game.highlightStatus === "processing" && !staleProcessing);
  // Optional background music — validate the track ID server-side.
  const musicTrackId = typeof req.body?.musicTrack === "string" ? req.body.musicTrack : undefined;
  const musicTrackPath = musicTrackId ? getMusicTrackPath(musicTrackId) : undefined;

  let startedAt = game.highlightStartedAt;
  if (!alreadyRunning) {
    inFlight.add(gameId);
    startedAt = new Date();
    await db
      .update(gamesTable)
      .set({
        highlightStatus: "processing",
        highlightError: null,
        highlightStartedAt: startedAt,
      })
      .where(eq(gamesTable.id, gameId));

    // Fire-and-forget: generation continues after the response is sent.
    // Hard timeout — download (~2 min) + proxy (22 chunks × ~3 min at nice -n 19)
    // + segment encoding + upload. 2-hr game = ~70 min; give 130 min buffer.
    const MAX_JOB_MS = 130 * 60 * 1000;
    void Promise.race([
      generateHighlight(gameId, musicTrackPath ?? undefined),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error("timeout")), MAX_JOB_MS)),
    ])
      .catch(async (err) => {
        // Only stamp the timeout message when the watchdog actually fired —
        // any other failure already wrote a specific error in generateHighlight.
        if ((err as Error)?.message !== "timeout") return;
        try {
          await db.update(gamesTable)
            .set({ highlightStatus: "failed", highlightError: "Generation timed out — tap Try Again to rebuild." })
            .where(eq(gamesTable.id, gameId));
        } catch { /* best-effort */ }
      })
      .finally(() => inFlight.delete(gameId));
  }

  res.status(202).json(
    GetGameHighlightResponse.parse({
      status: "processing",
      highlightObjectPath: game.highlightObjectPath ?? null,
      error: null,
      startedAt: startedAt?.toISOString() ?? null,
      eligibleMoments,
    }),
  );
});

/**
 * Re-trigger a highlight job that was orphaned by a server restart.
 * Called at startup for any game still stuck in "processing".
 * Safe to call multiple times — is a no-op if already in-flight.
 * Resets highlightStartedAt so the stale window is measured from this resume.
 */
export function resumeHighlightJob(gameId: number): void {
  if (inFlight.has(gameId)) return;
  inFlight.add(gameId);
  const startedAt = new Date();
  // Best-effort: reset startedAt so the stale window is accurate after restart.
  void db.update(gamesTable)
    .set({ highlightStartedAt: startedAt })
    .where(eq(gamesTable.id, gameId))
    .catch(() => {});
  const MAX_JOB_MS = 130 * 60 * 1000;
  void Promise.race([
    generateHighlight(gameId),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error("timeout")), MAX_JOB_MS)),
  ])
    .catch(async (err) => {
      // Only stamp the timeout message when the watchdog actually fired —
      // any other failure already wrote a specific error in generateHighlight.
      if ((err as Error)?.message !== "timeout") return;
      try {
        await db
          .update(gamesTable)
          .set({ highlightStatus: "failed", highlightError: "Generation timed out — tap Try Again to rebuild." })
          .where(eq(gamesTable.id, gameId));
      } catch { /* best-effort */ }
    })
    .finally(() => inFlight.delete(gameId));
}

router.delete("/games/:gameId/highlight", requireAuth, async (req, res) => {
  const { gameId } = GetGameParams.parse(req.params);
  const game = await db.query.gamesTable.findFirst({
    where: and(eq(gamesTable.id, gameId), eq(gamesTable.ownerId, req.appUser!.id)),
  });
  if (!game) { res.status(404).json({ error: "Game not found" }); return; }

  cancelHighlightGeneration(gameId);
  inFlight.delete(gameId);
  await db.update(gamesTable)
    .set({
      highlightStatus: null,
      highlightStartedAt: null,
      highlightObjectPath: null,
      highlightError: null,
    })
    .where(eq(gamesTable.id, gameId));

  res.json({ ok: true });
});

export default router;
