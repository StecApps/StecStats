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
import { getEntitlementsForUser, getEntitlements, isPro } from "../lib/entitlements";
import { getMusicTrackPath } from "../lib/musicTracks";
import {
  claimReelLease,
  invalidateOutdatedReadyReel,
  invalidateReelLease,
  updateReelIfOwner,
} from "../lib/reelLease";

const router: IRouter = Router();

// Guards against launching a second generation while one is already running
// for the same game (survives concurrent requests within this process).
const inFlight = new Set<number>();

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

  let highlightStatus = game.highlightStatus;
  let highlightError = game.highlightError;

  // Invalidate reels built by older clip-timing code. Reset to idle so the
  // UI shows a fresh Generate button — the user triggers the rebuild manually.
  let highlightObjectPath = game.highlightObjectPath;
  let highlightStartedAt = game.highlightStartedAt;
  if (
    highlightStatus === "ready" &&
    (game.highlightGeneratorVersion ?? 0) < GENERATOR_VERSION
  ) {
    const invalidated = await invalidateOutdatedReadyReel(
      gameId,
      "highlight",
      GENERATOR_VERSION,
    );
    if (invalidated) {
      highlightStatus = null;
      highlightError = null;
      highlightObjectPath = null;
      highlightStartedAt = null;
    }
  }

  // Legacy games may predate duration probing — self-heal lazily.
  if (game.videoObjectPath && game.videoDurationMs == null) {
    scheduleVideoDurationProbe(gameId, game.videoObjectPath);
  }

  const { eligibleMoments, onFilmMoments } = await getHighlightCoverage(game);
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
      eligibleMoments,
      onFilmMoments,
      musicTrack: game.highlightMusicTrack ?? null,
      youtubeUrl: game.highlightYoutubeUrl ?? null,
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
  const lease = await claimReelLease(gameId, "highlight", {
    highlightError: null,
    highlightMusicTrack: musicTrackId ?? null,
    highlightNotificationSent: false,
  });
  if (lease) {
    inFlight.add(gameId);
    startedAt = lease.startedAt;

    // Fire-and-forget: generation continues after the response is sent.
    // Hard timeout — download (~2 min) + proxy (22 chunks × ~3 min at nice -n 19)
    // + segment encoding + upload. 2-hr game = ~70 min; give 130 min buffer.
    const MAX_JOB_MS = 130 * 60 * 1000;
    void Promise.race([
      generateHighlight(gameId, musicTrackPath ?? undefined, lease.token),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error("timeout")), MAX_JOB_MS)),
    ])
      .catch(async (err) => {
        // Only stamp the timeout message when the watchdog actually fired —
        // any other failure already wrote a specific error in generateHighlight.
        if ((err as Error)?.message !== "timeout") return;
        try {
          await updateReelIfOwner(gameId, "highlight", lease.token, {
            highlightStatus: "failed",
            highlightError: "Generation timed out — tap Try Again to rebuild.",
            highlightRunToken: null,
            highlightLeaseExpiresAt: null,
          });
        } catch { /* best-effort */ } finally {
          cancelHighlightRun(gameId, lease.token);
        }
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
      musicTrack: musicTrackId ?? game.highlightMusicTrack ?? null,
    }),
  );
});

/**
 * Atomically claim and re-trigger a highlight job whose database lease expired.
 * Called at startup for processing games with no current owner.
 */
export async function resumeHighlightJob(gameId: number): Promise<void> {
  if (inFlight.has(gameId)) return;
  const lease = await claimReelLease(gameId, "highlight");
  if (!lease) return;
  inFlight.add(gameId);
  const MAX_JOB_MS = 130 * 60 * 1000;
  void Promise.race([
    generateHighlight(gameId, undefined, lease.token),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error("timeout")), MAX_JOB_MS)),
  ])
    .catch(async (err) => {
      // Only stamp the timeout message when the watchdog actually fired —
      // any other failure already wrote a specific error in generateHighlight.
      if ((err as Error)?.message !== "timeout") return;
      try {
        await updateReelIfOwner(gameId, "highlight", lease.token, {
          highlightStatus: "failed",
          highlightError: "Generation timed out — tap Try Again to rebuild.",
          highlightRunToken: null,
          highlightLeaseExpiresAt: null,
        });
      } catch { /* best-effort */ } finally {
        cancelHighlightRun(gameId, lease.token);
      }
    })
    .finally(() => inFlight.delete(gameId));
}

router.delete("/games/:gameId/highlight", requireAuth, async (req, res) => {
  const { gameId } = GetGameParams.parse(req.params);
  const game = await db.query.gamesTable.findFirst({
    where: and(eq(gamesTable.id, gameId), eq(gamesTable.ownerId, req.appUser!.id)),
  });
  if (!game) { res.status(404).json({ error: "Game not found" }); return; }

  cancelHighlightJob(gameId);
  inFlight.delete(gameId);
  // Use "failed" (not null) so the status is never "processing" at the
  // moment of an OOM kill — the auto-resume query only picks up
  // "processing" games, so "failed" breaks the infinite restart loop.
  await invalidateReelLease(gameId, "highlight", {
      highlightStatus: "failed",
      highlightStartedAt: null,
      highlightObjectPath: null,
      highlightError: "Generation was cancelled",
    });

  res.json({ ok: true });
});

export default router;
