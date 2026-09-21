import { Router, type IRouter, type Request, type Response } from "express";
import { createHmac, randomUUID } from "crypto";
import { liveStreamRegistry, getIceServers, getTurnAvailable } from "../lib/liveStream";
import { requireAuth } from "../middlewares/requireAuth";
import { getEntitlementsForUser, getEntitlements, isPro } from "../lib/entitlements";
import { and, eq, ne, sql } from "drizzle-orm";
import { db, gamesTable, liveSessionsTable, usersTable } from "@workspace/db";
import { createDailyMeetingToken, createDailyRoom, getDailyRoom, dailyConfigured, stopDailyRecording, startDailyRtmp, stopDailyRtmp } from "../lib/daily";
import { enqueueDailyRecordingImport } from "../lib/dailyRecordingImport";
import { createBroadcasterToken } from "../lib/liveAuth";
import { decryptToken, encryptToken } from "../lib/tokenEncryption";
import { ensureLiveResources, YouTubeAuthError } from "../lib/youtubeClient";

const router: IRouter = Router();
const LIVE_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export function deriveLiveSessionCode(ownerId: number, requestId: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`live-session:${ownerId}:${requestId}`)
    .digest("hex")
    .slice(0, 16)
    .toUpperCase();
}

/**
 * GET /live/ice-servers
 *
 * Returns the ICE server configuration (STUN + TURN) that broadcasters and
 * viewers should use for their WebRTC peer connections. Prefers a TURN relay
 * (via Metered.ca) so streams keep working behind restrictive NATs/firewalls
 * where direct/STUN-only connectivity fails; falls back to STUN-only if no
 * TURN provider is configured or reachable.
 */
router.get("/live/ice-servers", async (_req: Request, res: Response) => {
  const iceServers = await getIceServers();
  // turnAvailable is set as a side-effect of getIceServers(); read it after
  // the await so the value reflects the outcome of this exact fetch.
  const turnAvailable = getTurnAvailable() ?? false;
  res.json({ iceServers, turnAvailable });
});

/**
 * POST /live/start
 *
 * Starts a new invitation-only live stream session for the given game context.
 * Returns a short code that doubles as the "invitation" — anyone with the
 * code (or the watch link built from it) can join as a viewer. No accounts
 * are required on either side.
 */
router.post("/live/start", requireAuth, async (req: Request, res: Response) => {
  const entitlements = await getEntitlementsForUser(req.appUser!);
  if (!isPro(entitlements)) {
    res.status(403).json({
      error: "Live streaming is a Pro feature. Upgrade to Pro to broadcast games live.",
      code: "UPGRADE_REQUIRED",
    });
    return;
  }

  const { opponent, teamName, requestId } = req.body ?? {};
  if (typeof opponent !== "string" || !opponent.trim() || typeof teamName !== "string" || !teamName.trim()) {
    res.status(400).json({ error: "Missing or invalid required fields" });
    return;
  }
  if (requestId !== undefined && (
    typeof requestId !== "string" || !LIVE_REQUEST_ID_PATTERN.test(requestId)
  )) {
    res.status(400).json({
      error: "requestId must be 16-128 characters using only letters, numbers, '_' or '-'",
    });
    return;
  }

  let preferredCode: string | undefined;
  if (requestId !== undefined) {
    const secret = process.env.SESSION_SECRET;
    if (!secret) {
      res.status(500).json({ error: "Server is not configured for idempotent live sessions" });
      return;
    }
    preferredCode = deriveLiveSessionCode(req.appUser!.id, requestId, secret);
  }

  const session = await liveStreamRegistry.createSession(
    { opponent, teamName },
    preferredCode,
    req.appUser!.id,
  );
  if (process.env.NODE_ENV !== "test") {
    await db.update(liveSessionsTable).set({ youtubeLifecycleStatus: "pending" })
      .where(eq(liveSessionsTable.id, session.id));
  }
  if (process.env.NODE_ENV === "test") {
    res.json({
      code: session.code,
      broadcasterToken: createBroadcasterToken(session.code, req.appUser!.id),
    });
    return;
  }
  if (!dailyConfigured()) {
    await liveStreamRegistry.endSession(session.code);
    res.status(503).json({ error: "Live video is not configured" });
    return;
  }
  try {
    const roomName = `stec-${req.appUser!.id}-${session.code.toLowerCase()}`;
    let daily;
    try {
      daily = await createDailyRoom(roomName);
    } catch (error) {
      // A retried idempotent start can encounter the room created by the
      // first request. Reusing it is safe because the name is owner+session
      // derived and every token remains room-scoped.
      daily = await getDailyRoom(roomName).catch(() => { throw error; });
    }
    const meeting = await createDailyMeetingToken(daily.name, {
      owner: true,
      userId: `coach-${req.appUser!.id}`,
    });
    await db.update(liveSessionsTable).set({
      dailyRoomName: daily.name,
      dailyRoomUrl: daily.url,
      dailyRecordingStatus: "ready",
    }).where(eq(liveSessionsTable.code, session.code));
    res.json({
      code: session.code,
      roomUrl: daily.url,
      token: meeting.token,
      broadcasterToken: createBroadcasterToken(session.code, req.appUser!.id),
    });
  } catch (error) {
    await liveStreamRegistry.endSession(session.code);
    req.log.error({ err: error }, "Failed to initialize Daily live room");
    res.status(502).json({ error: "Unable to initialize live video" });
  }
});

router.get("/live/:code/daily-token", async (req: Request, res: Response) => {
  const code = String(req.params.code ?? "").toUpperCase();
  const [session] = await db.select().from(liveSessionsTable)
    .where(and(eq(liveSessionsTable.code, code), eq(liveSessionsTable.active, true))).limit(1);
  if (!session?.dailyRoomName) {
    res.status(404).json({ error: "Live video is not available" });
    return;
  }
  try {
    const room = await createDailyMeetingToken(session.dailyRoomName, {
      owner: false,
      userId: `viewer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
    const status = await liveStreamRegistry.getOrResumeSession(code);
    res.json({
      roomUrl: session.dailyRoomUrl,
      token: room.token,
      active: Boolean(status?.broadcaster),
    });
  } catch (error) {
    req.log.error({ err: error, code }, "Failed to create Daily viewer token");
    res.status(502).json({ error: "Unable to initialize live video" });
  }
});

/**
 * GET /live/:code/status
 *
 * Public status check used by the viewer page. Does not require the caller
 * to be the broadcaster. Falls back to the persisted session record if the
 * in-memory copy was lost to an api-server restart, so viewers polling this
 * endpoint see "waiting for broadcaster" (and keep retrying) instead of a
 * hard "not found" while the coach's app is busy reconnecting.
 */
router.get("/live/:code/status", async (req: Request, res: Response) => {
  const code = Array.isArray(req.params.code) ? req.params.code[0] : req.params.code;
  const session = await liveStreamRegistry.getOrResumeSession(code ?? "");
  if (!session) {
    res.status(404).json({ error: "Stream not found" });
    return;
  }
  const persisted = await db.query.liveSessionsTable.findFirst({
    where: eq(liveSessionsTable.code, String(code ?? "").toUpperCase()),
  });

  res.json({
    active: session.broadcaster !== null,
    opponent: session.meta.opponent,
    teamName: session.meta.teamName,
    viewerCount: session.viewers.size,
    teamScore: session.scoreboard.teamScore,
    opponentScore: session.scoreboard.opponentScore,
    // The branded watch page uses Daily directly so it can keep the live
    // scoreboard overlay. YouTube remains the external distribution/archive;
    // channels can reject third-party embedding even when the video is live.
    videoMode: persisted?.dailyRoomName ? "daily" : "webrtc",
    youtubeVideoId: persisted?.youtubeVideoId ?? null,
    youtubeWatchUrl: persisted?.youtubeWatchUrl ?? null,
    scoreboardDelayMs: 0,
  });
});

router.post("/live/:code/youtube/start", requireAuth, async (req: Request, res: Response) => {
  const code = String(req.params.code ?? "").toUpperCase();
  try {
    const phase = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${code}, 0))`);
      const session = await tx.query.liveSessionsTable.findFirst({
        where: and(eq(liveSessionsTable.code, code), eq(liveSessionsTable.ownerId, req.appUser!.id)),
      });
      if (!session?.dailyRoomName) throw Object.assign(new Error("Live session or Daily room not found"), { status: 404 });
      if (session.youtubeLifecycleStatus === "live" && session.youtubeVideoId) {
        return { existing: true, videoId: session.youtubeVideoId, watchUrl: session.youtubeWatchUrl, code: session.code };
      }
      if (session.youtubeLifecycleStatus === "starting" &&
          session.youtubeAttemptLeaseUntil && session.youtubeAttemptLeaseUntil > new Date()) {
        return { existing: true, starting: true, videoId: session.youtubeVideoId, watchUrl: session.youtubeWatchUrl, code: session.code };
      }
      const user = await tx.query.usersTable.findFirst({ where: eq(usersTable.id, req.appUser!.id), columns: { youtubeRefreshToken: true } });
      if (!user?.youtubeRefreshToken) throw Object.assign(new Error("Connect YouTube before starting public live"), { status: 409, code: "YOUTUBE_NOT_CONNECTED" });
      const attemptToken = randomUUID();
      await tx.update(liveSessionsTable).set({
        youtubeLifecycleStatus: "starting", youtubeLifecycleError: null,
        youtubeAttemptToken: attemptToken, youtubeAttemptLeaseUntil: new Date(Date.now() + 5 * 60_000),
      })
        .where(eq(liveSessionsTable.id, session.id));
      return { existing: false, code: session.code, sessionId: session.id, room: session.dailyRoomName, token: attemptToken, refreshToken: decryptToken(user.youtubeRefreshToken), broadcastId: session.youtubeBroadcastId, streamId: session.youtubeStreamId };
    });
    if (phase.existing) {
      res.status(phase.starting ? 202 : 200).json({ videoId: phase.videoId, watchUrl: phase.watchUrl, ...(phase.starting ? { status: "starting" } : {}) });
      return;
    }
    const work = phase as { refreshToken: string; sessionId: number; token: string; room: string; broadcastId?: string | null; streamId?: string | null; code: string };
    const fenced = and(eq(liveSessionsTable.id, work.sessionId), eq(liveSessionsTable.youtubeAttemptToken, work.token));
    let dailyMayHaveStarted = false;
    const resources = await ensureLiveResources(work.refreshToken, {
      broadcastId: work.broadcastId,
      streamId: work.streamId,
      onBroadcastReady: async (broadcastId) => {
        await db.update(liveSessionsTable).set({ youtubeBroadcastId: broadcastId }).where(fenced);
      },
      onStreamReady: async (streamId) => {
        await db.update(liveSessionsTable).set({ youtubeStreamId: streamId }).where(fenced);
      },
    });
    await db.update(liveSessionsTable).set({
      youtubeBroadcastId: resources.broadcastId, youtubeStreamId: resources.streamId,
      youtubeVideoId: null, youtubeWatchUrl: null, youtubeRtmpUrl: resources.rtmpUrl,
      youtubeStreamKey: encryptToken(resources.streamKey), youtubeLifecycleStatus: "resources_ready",
    }).where(fenced);
    await startDailyRtmp(work.room, resources.rtmpUrl, resources.streamKey);
    dailyMayHaveStarted = true;
    await db.update(liveSessionsTable).set({
      youtubeLifecycleStatus: "live", youtubeVideoId: resources.videoId, youtubeWatchUrl: resources.watchUrl,
      youtubeAttemptToken: null, youtubeAttemptLeaseUntil: null,
    }).where(fenced);
    liveStreamRegistry.markYoutubeDelayed(work.code);
    res.json({ videoId: resources.videoId, watchUrl: resources.watchUrl });
  } catch (error) {
    const persisted = await db.query.liveSessionsTable.findFirst({
      where: and(eq(liveSessionsTable.code, code), eq(liveSessionsTable.ownerId, req.appUser!.id)),
    }).catch(() => undefined);
    if (persisted?.dailyRoomName && persisted.youtubeLifecycleStatus === "resources_ready") {
      await stopDailyRtmp(persisted.dailyRoomName).catch(() => {});
    }
    await db.update(liveSessionsTable).set({
      youtubeLifecycleStatus: "error",
      youtubeLifecycleError: error instanceof Error ? error.message.slice(0, 1000) : String(error),
      youtubeAttemptToken: null,
      youtubeAttemptLeaseUntil: null,
    }).where(eq(liveSessionsTable.code, code)).catch(() => {});
    if (error instanceof YouTubeAuthError) {
      const code = /not enabled/i.test(error.message) ? "YOUTUBE_LIVE_NOT_ENABLED" : "YOUTUBE_RECONNECT_REQUIRED";
      res.status(403).json({ error: error.message, code });
      return;
    }
    const typed = error as { status?: number; code?: string; message?: string };
    if (typed.status === 404 || typed.status === 409) {
      res.status(typed.status).json({ error: typed.message, code: typed.code });
      return;
    }
    req.log.error({ err: error, code }, "Failed to start YouTube Live");
    res.status(502).json({ error: "Unable to start public YouTube live" });
  }
});

/**
 * POST /live/:code/stop
 *
 * Explicit stop (in addition to automatic cleanup when the broadcaster's
 * websocket disconnects).
 */
router.post("/live/:code/stop", requireAuth, async (req: Request, res: Response) => {
  const code = Array.isArray(req.params.code) ? req.params.code[0] : req.params.code;
  const persisted = await db.query.liveSessionsTable.findFirst({
    where: and(eq(liveSessionsTable.code, code ?? ""), eq(liveSessionsTable.ownerId, req.appUser!.id)),
  });
  if (!persisted) { res.status(404).json({ error: "Stream not found" }); return; }
  if (persisted.youtubeLifecycleStatus === "ending" || persisted.youtubeLifecycleStatus === "ending_error") {
    res.status(202).json({ success: true, endingAt: persisted.youtubeEndingAt });
    return;
  }
  if (persisted.dailyRoomName) {
    if (persisted.youtubeVideoId) {
      try {
        await stopDailyRtmp(persisted.dailyRoomName);
      } catch (error) {
        req.log.warn({ err: error }, "Daily RTMP stop failed");
        res.status(502).json({ error: "Unable to stop public live relay; retry" });
        return;
      }
      const endingAt = new Date(Date.now() + 10_000);
      await db.update(liveSessionsTable).set({
        youtubeEndingAt: endingAt,
        youtubeLifecycleStatus: "ending",
      }).where(eq(liveSessionsTable.id, persisted.id));
      res.status(202).json({ success: true, endingAt });
      return;
    }
    await stopDailyRecording(persisted.dailyRoomName).catch((error) =>
      req.log.warn({ err: error }, "Daily recording stop failed; import worker will retry"),
    );
    await db.update(liveSessionsTable).set({ dailyRecordingStatus: "stopped" })
      .where(eq(liveSessionsTable.id, persisted.id));
  }
  await liveStreamRegistry.endSession(code ?? "");
  res.json({ success: true });
});

router.post("/live/:code/recording/attach", requireAuth, async (req: Request, res: Response) => {
  const code = String(req.params.code ?? "").toUpperCase();
  const gameId = Number(req.body?.gameId);
  if (!Number.isSafeInteger(gameId) || gameId <= 0) {
    res.status(400).json({ error: "gameId is required" });
    return;
  }
  const session = await db.query.liveSessionsTable.findFirst({
    where: and(eq(liveSessionsTable.code, code), eq(liveSessionsTable.ownerId, req.appUser!.id)),
  });
  const game = await db.query.gamesTable.findFirst({
    where: and(eq(gamesTable.id, gameId), eq(gamesTable.ownerId, req.appUser!.id)),
  });
  if (!session || !game || !session.dailyRoomName) {
    res.status(404).json({ error: "Live session or game not found" });
    return;
  }
  await enqueueDailyRecordingImport({
    liveSessionId: session.id,
    gameId,
    ownerId: req.appUser!.id,
    dailyRoomName: session.dailyRoomName,
    dailyRecordingId: session.dailyRecordingId,
  });
  res.status(202).json({ status: "queued" });
});

export default router;
