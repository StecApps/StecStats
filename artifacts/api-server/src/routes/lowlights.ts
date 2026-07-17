import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, gamesTable } from "@workspace/db";
import { GetGameParams } from "@workspace/api-zod";
import {
  countLowlightMoments,
  generateLowlight,
} from "../lib/highlightGenerator";
import { requireAuth } from "../middlewares/requireAuth";
import { getEntitlements, isPro } from "../lib/entitlements";

const router: IRouter = Router();

const inFlight = new Set<number>();
// 10-minute stale window — job is considered abandoned after this.
const STALE_PROCESSING_MS = 30 * 60 * 1000; // 30 minutes — large files can take ~15 min

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
  const isStale =
    lowlightStatus === "processing" &&
    !inFlight.has(gameId) &&
    Date.now() - startedAtMs > STALE_PROCESSING_MS;
  if (isStale) {
    lowlightStatus = "failed";
    lowlightError = "Generation timed out — tap Try Again to rebuild.";
    await db.update(gamesTable).set({ lowlightStatus, lowlightError }).where(eq(gamesTable.id, gameId));
  }

  const eligibleMoments = await countLowlightMoments(gameId);
  res.json({
    status: normalizeStatus(lowlightStatus),
    lowlightObjectPath: game.lowlightObjectPath ?? null,
    error: lowlightError ?? null,
    startedAt: isStale ? null : (game.lowlightStartedAt?.toISOString() ?? null),
    eligibleMoments,
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

  const startedAtMs = game.lowlightStartedAt ? new Date(game.lowlightStartedAt).getTime() : 0;
  const staleProcessing = game.lowlightStatus === "processing" && Date.now() - startedAtMs > STALE_PROCESSING_MS;
  const alreadyRunning = inFlight.has(gameId) || (game.lowlightStatus === "processing" && !staleProcessing);
  let startedAt = game.lowlightStartedAt;
  if (!alreadyRunning) {
    inFlight.add(gameId);
    startedAt = new Date();
    await db.update(gamesTable).set({ lowlightStatus: "processing", lowlightError: null, lowlightStartedAt: startedAt }).where(eq(gamesTable.id, gameId));
    // Hard timeout — generous for large games where source download (~3 min)
    // + serialized ffmpeg encodes (13 segments × ~45s) can take ~15 min total.
    const MAX_JOB_MS = 40 * 60 * 1000;
    void Promise.race([
      generateLowlight(gameId),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error("timeout")), MAX_JOB_MS)),
    ])
      .catch(async () => {
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
  const MAX_JOB_MS = 40 * 60 * 1000;
  void Promise.race([
    generateLowlight(gameId),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error("timeout")), MAX_JOB_MS)),
  ])
    .catch(async () => {
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

  inFlight.delete(gameId);
  await db.update(gamesTable)
    .set({
      lowlightStatus: null,
      lowlightStartedAt: null,
      lowlightObjectPath: null,
      lowlightError: null,
    })
    .where(eq(gamesTable.id, gameId));

  res.json({ ok: true });
});

export default router;
