import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, liveSessionsTable, livePublicEventsTable, usersTable } from "@workspace/db";
import { stopDailyRecording, stopDailyRtmp } from "./daily";
import { stopLiveBroadcast } from "./youtubeClient";
import { decryptToken } from "./tokenEncryption";
import { liveStreamRegistry } from "./liveStream";
import { logger } from "./logger";

export async function finalizeDueLiveSessions(): Promise<void> {
  const claimToken = randomUUID();
  const claimed = await db.execute(sql`
    UPDATE live_sessions
    SET youtube_finalizer_claim_token = ${claimToken},
        youtube_finalizer_claimed_until = NOW() + INTERVAL '1 minute'
    WHERE id IN (
      SELECT id FROM live_sessions
      WHERE active = true
        AND youtube_lifecycle_status IN ('ending', 'ending_error')
        AND youtube_ending_at <= NOW()
        AND (youtube_finalizer_claimed_until IS NULL OR youtube_finalizer_claimed_until < NOW())
      ORDER BY youtube_ending_at, id
      FOR UPDATE SKIP LOCKED
      LIMIT 10
    )
    RETURNING id
  `);
  for (const row of claimed.rows as Array<{ id: number }>) {
    const session = await db.query.liveSessionsTable.findFirst({
      where: and(
        eq(liveSessionsTable.id, row.id),
        eq(liveSessionsTable.youtubeFinalizerClaimToken, claimToken),
      ),
    });
    if (!session) continue;
    const pending = await db.execute(sql`
      SELECT 1 FROM live_public_events
      WHERE live_session_id = ${session.id}
        AND status IN ('queued','claimed')
      LIMIT 1
    `);
    if (pending.rows.length) {
      await db.update(liveSessionsTable).set({
        youtubeFinalizerClaimToken: null,
        youtubeFinalizerClaimedUntil: null,
      }).where(and(
        eq(liveSessionsTable.id, session.id),
        eq(liveSessionsTable.youtubeFinalizerClaimToken, claimToken),
      ));
      continue;
    }
    try {
      if (session.youtubeStreamKey && session.dailyRoomName) await stopDailyRtmp(session.dailyRoomName).catch(() => {});
      const user = await db.query.usersTable.findFirst({ where: eq(usersTable.id, session.ownerId), columns: { youtubeRefreshToken: true } });
      if (user?.youtubeRefreshToken && session.youtubeBroadcastId) {
        await stopLiveBroadcast(decryptToken(user.youtubeRefreshToken), session.youtubeBroadcastId);
      }
      if (session.dailyRoomName) await stopDailyRecording(session.dailyRoomName);
      await db.update(liveSessionsTable).set({
        active: false,
        youtubeLifecycleStatus: "complete",
        youtubeEndingAt: null,
        dailyRecordingStatus: "stopped",
        youtubeFinalizerClaimToken: null,
        youtubeFinalizerClaimedUntil: null,
      }).where(and(
        eq(liveSessionsTable.id, session.id),
        eq(liveSessionsTable.youtubeFinalizerClaimToken, claimToken),
      ));
      await liveStreamRegistry.endSession(session.code);
    } catch (error) {
      await db.update(liveSessionsTable).set({
        youtubeLifecycleStatus: "ending_error",
        youtubeLifecycleError: String(error).slice(0, 1000),
        youtubeFinalizerClaimToken: null,
        youtubeFinalizerClaimedUntil: null,
      }).where(and(
        eq(liveSessionsTable.id, session.id),
        eq(liveSessionsTable.youtubeFinalizerClaimToken, claimToken),
      ));
      logger.warn({ err: error, sessionId: session.id }, "Live finalization will retry");
    }
  }
}

export function startLiveFinalizerWorker(): void {
  const timer = setInterval(() => void finalizeDueLiveSessions().catch((error) => logger.warn({ err: error }, "Live finalizer poll failed")), 5_000);
  timer.unref();
  void finalizeDueLiveSessions();
}