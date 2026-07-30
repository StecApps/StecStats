import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, gamesTable } from "@workspace/db";
import { GetGameParams } from "@workspace/api-zod";
import {
  countLowlightMoments,
  getLowlightCoverage,
  generateLowlight,
  cancelLowlightJob,
  GENERATOR_VERSION,
} from "../lib/highlightGenerator";
import { scheduleVideoDurationProbe } from "../lib/videoDuration";
import { requireAuth } from "../middlewares/requireAuth";
import { getEntitlements, isPro } from "../lib/entitlements";
import { getMusicTrackPath } from "../lib/musicTracks";

const router: IRouter = Router();

const inFlight = new Set<number>();
const STALE_PROCESSING_MS = 5 * 60 * 1000;
// Must be ≥ PROCESS_TIMEOUT_MS in highlightGenerator.ts (currently 90 min).
const HARD_STALE_MS = 95 * 60 * 1000;

function normalizeStatus(raw: string | null): "idle" | "processing" | "ready" | "failed" {
  if (raw === "processing" || raw === "ready" || raw === "failed") return raw;
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
  const startedAtMs = game.lowlightStartedAt ? new Date(game.lowlightStartedAt).getTime() : 0;
  const elapsed = Date.now() - startedAtMs;
  const isStale =
    lowlightStatus === "processing" &&
    (elapsed > HARD_STALE_MS || (!inFlight.has(gameId) && elapsed > STALE_PROCESSING_MS));
  if (isStale) {
    lowlightStatus = "failed";
    lowlightError = "Generation timed out — tap Try Again to rebuild.";
    await db.update(gamesTable).set({ lowlightStatus, lowlightError }).where(eq(gamesTable.id, gameId));
  }

  // Invalidate reels built by older clip-timing code. Reset to idle so the
  // UI shows a fresh Generate button — the user triggers the rebuild manually.
  let lowlightObjectPath = game.lowlightObjectPath;
  let lowlightStartedAt = game.lowlightStartedAt;
  if (
    lowlightStatus === "ready" &&
    (game.lowlightGeneratorVersion ?? 0) < GENERATOR_VERSION
  ) {
    lowlightStatus = null;
    lowlightError = null;
    lowlightObjectPath = null;
    lowlightStartedAt = null;
    await db.update(gamesTable)
      .set({ lowlightStatus: null, lowlightError: null, lowlightObjectPath: null, lowlightStartedAt: null })
      .where(eq(gamesTable.id, gameId));
  }

  // Legacy games may predate duration probing — self-heal lazily.
  if (game.videoObjectPath && game.videoDurationMs == null) {
    scheduleVideoDurationProbe(gameId, game.videoObjectPath);
  }

  const { eligibleMoments, onFilmMoments } = await getLowlightCoverage(game);
  res.json({
    status: normalizeStatus(lowlightStatus),
    lowlightObjectPath: lowlightObjectPath ?? null,
    error: lowlightError ?? null,
    startedAt: isStale ? null : (lowlightStartedAt?.toISOString() ?? null),
    eligibleMoments,
    onFilmMoments,
  });
});

router.post("/games/:gameId/lowlight", requireAuth, async (req, res) => {
  const { gameId } = GetGameParams.parse(req.params);
  const game = await db.query.gamesTable.findFirst({
    where: and(eq(gamesTable.id, gameId), eq(gamesTable.ownerId, req.appUser!.id)),
  });
  if (!game) { res.status(404).json({ error: "Game not found" }); return; }

  const entitlements = await getEntitlements(req.appUser!.stripeCustomerId, req.appUser!.email);
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

  const startedAtMs = game.lowlightStartedAt ? new Date(game.lowlightStartedAt).getTime() : 0;
  const elapsedMs = Date.now() - startedAtMs;
  const staleProcessing =
    game.lowlightStatus === "processing" &&
    (elapsedMs > HARD_STALE_MS || (!inFlight.has(gameId) && elapsedMs > STALE_PROCESSING_MS));
  const alreadyRunning = inFlight.has(gameId) || (game.lowlightStatus === "processing" && !staleProcessing);
  let startedAt = game.lowlightStartedAt;
  if (!alreadyRunning) {
    inFlight.add(gameId);
    startedAt = new Date();
    await db.update(gamesTable).set({ lowlightStatus: "processing", lowlightError: null, lowlightStartedAt: startedAt }).where(eq(gamesTable.id, gameId));
    // Hard timeout — 2-hr game: download + proxy (nice -n 19) + encode + upload
    const MAX_JOB_MS = 130 * 60 * 1000;
    void Promise.race([
      generateLowlight(gameId, musicTrackPath ?? undefined),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error("timeout")), MAX_JOB_MS)),
    ])
      .catch(async (err) => {
        // Only stamp the timeout message when the watchdog actually fired —
        // any other failure already wrote a specific error in generateLowlight.
        if ((err as Error)?.message !== "timeout") return;
        try {
          await db.update(gamesTable)
            .set({ lowlightStatus: "failed", lowlightError: "Generation timed out — tap Try Again to rebuild." })
            .where(eq(gamesTable.id, gameId));
        } catch { /* best-effort */ }
      })
      .finally(() => inFlight.delete(gameId));
  }

  res.status(202).json({
    status: "processing",
    lowlightObjectPath: game.lowlightObjectPath ?? null,
    error: null,
    startedAt: startedAt?.toISOString() ?? null,
    eligibleMoments,
  });
});

/**
 * Re-trigger a lowlight job that was orphaned by a server restart.
 * Called at startup for any game still stuck in "processing".
 * Resets lowlightStartedAt so the stale window is measured from this resume.
 */
export function resumeLowlightJob(gameId: number): void {
  if (inFlight.has(gameId)) return;
  inFlight.add(gameId);
  const startedAt = new Date();
  void db.update(gamesTable)
    .set({ lowlightStartedAt: startedAt })
    .where(eq(gamesTable.id, gameId))
    .catch(() => {});
  const MAX_JOB_MS = 130 * 60 * 1000;
  void Promise.race([
    generateLowlight(gameId),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error("timeout")), MAX_JOB_MS)),
  ])
    .catch(async (err) => {
      // Only stamp the timeout message when the watchdog actually fired —
      // any other failure already wrote a specific error in generateLowlight.
      if ((err as Error)?.message !== "timeout") return;
      try {
        await db
          .update(gamesTable)
          .set({ lowlightStatus: "failed", lowlightError: "Generation timed out — tap Try Again to rebuild." })
          .where(eq(gamesTable.id, gameId));
      } catch { /* best-effort */ }
    })
    .finally(() => inFlight.delete(gameId));
}

router.delete("/games/:gameId/lowlight", requireAuth, async (req, res) => {
  const { gameId } = GetGameParams.parse(req.params);
  const game = await db.query.gamesTable.findFirst({
    where: and(eq(gamesTable.id, gameId), eq(gamesTable.ownerId, req.appUser!.id)),
  });
  if (!game) { res.status(404).json({ error: "Game not found" }); return; }

  cancelLowlightJob(gameId);
  inFlight.delete(gameId);
  await db.update(gamesTable)
    .set({
      lowlightStatus: "failed",
      lowlightStartedAt: null,
      lowlightObjectPath: null,
      lowlightError: "Generation was cancelled",
    })
    .where(eq(gamesTable.id, gameId));

  res.json({ ok: true });
});

export default router;
