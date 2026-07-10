import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, gamesTable } from "@workspace/db";
import { GetGameParams, GetGameHighlightResponse } from "@workspace/api-zod";
import {
  countEligibleMoments,
  generateHighlight,
} from "../lib/highlightGenerator";
import { requireAuth } from "../middlewares/requireAuth";
import { getEntitlements, isPro } from "../lib/entitlements";

const router: IRouter = Router();

// Guards against launching a second generation while one is already running
// for the same game (survives concurrent requests within this process).
const inFlight = new Set<number>();

// A DB status of "processing" older than this is considered abandoned (e.g. the
// server restarted mid-job) and may be retried.
const STALE_PROCESSING_MS = 10 * 60 * 1000;

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
  const isStale =
    highlightStatus === "processing" &&
    !inFlight.has(gameId) &&
    Date.now() - startedAtMs > STALE_PROCESSING_MS;
  if (isStale) {
    highlightStatus = "failed";
    highlightError = "Generation timed out — tap Try Again to rebuild.";
    await db
      .update(gamesTable)
      .set({ highlightStatus, highlightError })
      .where(eq(gamesTable.id, gameId));
  }

  const eligibleMoments = await countEligibleMoments(gameId);
  res.json(
    GetGameHighlightResponse.parse({
      status: normalizeStatus(highlightStatus),
      highlightObjectPath: game.highlightObjectPath ?? null,
      error: highlightError ?? null,
      startedAt: isStale ? null : (game.highlightStartedAt?.toISOString() ?? null),
      eligibleMoments,
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
  const staleProcessing =
    game.highlightStatus === "processing" && Date.now() - startedAtMs > STALE_PROCESSING_MS;
  const alreadyRunning =
    inFlight.has(gameId) || (game.highlightStatus === "processing" && !staleProcessing);
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
    void generateHighlight(gameId)
      .catch(() => {})
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

export default router;
