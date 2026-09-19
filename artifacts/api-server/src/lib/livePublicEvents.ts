import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, livePublicEventsTable, liveSessionsTable } from "@workspace/db";
import { liveStreamRegistry } from "./liveStream";
import { logger } from "./logger";

const LEASE_MS = 60_000;
const POLL_MS = 1_000;
let timer: NodeJS.Timeout | undefined;

export async function enqueueLivePublicEvent(
  liveSessionId: number,
  eventType: "scoreboard" | "stat-event",
  payload: unknown,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO live_public_events
      (live_session_id, event_type, payload, apply_at, status)
    VALUES (${liveSessionId}, ${eventType}, ${JSON.stringify(payload)}::jsonb,
      NOW() + INTERVAL '10 seconds', 'queued')
  `);
}

async function pollOnce(): Promise<void> {
  const token = randomUUID();
  const result = await db.execute(sql`
    UPDATE live_public_events
    SET status = 'claimed', claim_token = ${token},
        claimed_until = NOW() + INTERVAL '1 minute'
    WHERE id IN (
      SELECT id FROM live_public_events
      WHERE (status = 'queued' OR (status = 'claimed' AND claimed_until < NOW()))
        AND apply_at <= NOW()
      ORDER BY apply_at, id FOR UPDATE SKIP LOCKED LIMIT 25
    )
    RETURNING id, live_session_id, event_type, payload, claim_token, apply_at
  `);
  const events = result.rows as Array<{ id: number; live_session_id: number; event_type: string; payload: unknown; claim_token: string; apply_at: Date | string }>;
  events.sort((a, b) => {
    const time = new Date(a.apply_at).getTime() - new Date(b.apply_at).getTime();
    return time || a.id - b.id;
  });
  for (const event of events) {
   try {
    const session = liveStreamRegistry.getSessionById(event.live_session_id);
    const active = await db.query.liveSessionsTable.findFirst({
      where: eq(liveSessionsTable.id, event.live_session_id),
    });
    if (!active) throw new Error("Live session was deleted");
    if (session) liveStreamRegistry.publishPublicEvent(session.code, event.event_type, event.payload);
    if (event.event_type === "scoreboard") {
      const score = event.payload as { teamScore: number; opponentScore: number };
      await db.update(liveSessionsTable).set({ teamScore: score.teamScore, opponentScore: score.opponentScore })
        .where(eq(liveSessionsTable.id, event.live_session_id));
    }
    await db.update(livePublicEventsTable).set({ status: "delivered", deliveredAt: new Date(), claimToken: null, claimedUntil: null })
      .where(and(eq(livePublicEventsTable.id, event.id), eq(livePublicEventsTable.claimToken, event.claim_token)));
  } catch (error) {
    logger.warn({ err: error, eventId: event.id }, "Public live event delivery will retry");
    await db.execute(sql`UPDATE live_public_events SET status='queued', claim_token=NULL, claimed_until=NULL WHERE id=${event.id} AND claim_token=${event.claim_token}`);
  }
  }
}

export function startLivePublicEventWorker(): void {
  if (timer) return;
  void pollOnce();
  timer = setInterval(() => void pollOnce(), POLL_MS);
  timer.unref();
}