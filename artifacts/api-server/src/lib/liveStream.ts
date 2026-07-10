import type { WebSocket } from "ws";
import { and, eq, lt } from "drizzle-orm";
import { db, liveSessionsTable } from "@workspace/db";
import { logger } from "./logger";

export type IceServer = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

const FALLBACK_ICE_SERVERS: IceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

let cachedIceServers: { servers: IceServer[]; expiresAt: number } | null = null;

export async function getIceServers(): Promise<IceServer[]> {
  const apiKey = process.env.METERED_API_KEY;
  const domain = process.env.METERED_DOMAIN;

  if (!apiKey || !domain) {
    return FALLBACK_ICE_SERVERS;
  }

  if (cachedIceServers && cachedIceServers.expiresAt > Date.now()) {
    return cachedIceServers.servers;
  }

  try {
    const url = `https://${domain}/api/v1/turn/credentials?apiKey=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url);
    if (!res.ok) {
      logger.warn({ status: res.status }, "Failed to fetch TURN credentials from Metered.ca, falling back to STUN-only");
      return FALLBACK_ICE_SERVERS;
    }
    const servers = (await res.json()) as IceServer[];
    if (!Array.isArray(servers) || servers.length === 0) {
      return FALLBACK_ICE_SERVERS;
    }
    // Metered credentials are valid for a while; cache for 30 minutes to avoid
    // hitting rate limits, well under their expiry window.
    cachedIceServers = { servers, expiresAt: Date.now() + 30 * 60 * 1000 };
    return servers;
  } catch (err) {
    logger.warn({ err }, "Error fetching TURN credentials from Metered.ca, falling back to STUN-only");
    return FALLBACK_ICE_SERVERS;
  }
}

export type LiveSessionMeta = {
  opponent: string;
  teamName: string;
};

export type Scoreboard = {
  teamScore: number;
  opponentScore: number;
};

export type StatEvent = {
  id: string;
  playerName: string;
  label: string;
  timestamp: number;
};

export const MAX_RECENT_STAT_EVENTS = 8;

export type LiveSession = {
  code: string;
  meta: LiveSessionMeta;
  createdAt: number;
  broadcaster: WebSocket | null;
  viewers: Map<string, WebSocket>;
  scoreboard: Scoreboard;
  recentEvents: StatEvent[];
};

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateCode(length = 6): string {
  let code = "";
  for (let i = 0; i < length; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

const HEARTBEAT_THROTTLE_MS = 10 * 60 * 1000;

class LiveStreamRegistry {
  private sessions = new Map<string, LiveSession>();
  private lastHeartbeatAt = new Map<string, number>();

  /**
   * Heartbeat: refreshes the persisted lastSeenAt for a session with live
   * activity (signaling, scoreboard/stat updates, joins). Throttled to one
   * DB write per session per 10 minutes so ongoing streams never look
   * "abandoned" to the cleanup job, without hammering the database.
   */
  touchSession(code: string): void {
    const upper = code.toUpperCase();
    const now = Date.now();
    const last = this.lastHeartbeatAt.get(upper) ?? 0;
    if (now - last < HEARTBEAT_THROTTLE_MS) return;
    this.lastHeartbeatAt.set(upper, now);
    db.update(liveSessionsTable)
      .set({ lastSeenAt: new Date() })
      .where(eq(liveSessionsTable.code, upper))
      .catch((err: unknown) => {
        this.lastHeartbeatAt.delete(upper);
        logger.warn({ err, code: upper }, "Failed to heartbeat live session lastSeenAt");
      });
  }

  /**
   * Creates a new session in memory AND persists its metadata (code,
   * opponent, teamName) to the database. Persisting the metadata is what
   * lets a session's invite code survive an api-server restart/redeploy:
   * broadcaster/viewer WebSocket connections and RTCPeerConnections cannot
   * survive a process restart, but the *code* can, so clients can detect
   * the drop and rejoin the same session once the server comes back up
   * instead of the invite link being permanently dead.
   */
  async createSession(meta: LiveSessionMeta): Promise<LiveSession> {
    let code = generateCode();
    while (this.sessions.has(code) || (await this.codeExistsInDb(code))) {
      code = generateCode();
    }
    const session: LiveSession = {
      code,
      meta,
      createdAt: Date.now(),
      broadcaster: null,
      viewers: new Map(),
      scoreboard: { teamScore: 0, opponentScore: 0 },
      recentEvents: [],
    };
    this.sessions.set(code, session);
    try {
      await db.insert(liveSessionsTable).values({
        code,
        opponent: meta.opponent,
        teamName: meta.teamName,
        active: true,
      });
    } catch (err) {
      logger.error({ err, code }, "Failed to persist live session, invite will not survive a restart");
    }
    return session;
  }

  private async codeExistsInDb(code: string): Promise<boolean> {
    const rows = await db
      .select({ id: liveSessionsTable.id })
      .from(liveSessionsTable)
      .where(eq(liveSessionsTable.code, code))
      .limit(1);
    return rows.length > 0;
  }

  getSession(code: string): LiveSession | undefined {
    return this.sessions.get(code.toUpperCase());
  }

  /**
   * Looks up a session, transparently resuming it from the database if the
   * in-memory copy is gone (e.g. the api-server process restarted mid-game
   * and lost all in-memory WebSocket/peer state). Resuming re-creates the
   * in-memory shell (broadcaster: null, no viewers) so the coach/viewers can
   * rejoin with the same invite code rather than getting "stream not found".
   */
  async getOrResumeSession(code: string): Promise<LiveSession | undefined> {
    const upper = code.toUpperCase();
    const existing = this.sessions.get(upper);
    if (existing) return existing;

    const rows = await db
      .select()
      .from(liveSessionsTable)
      .where(eq(liveSessionsTable.code, upper))
      .limit(1);
    const row = rows[0];
    if (!row || !row.active) return undefined;

    // Re-check after the async DB read: two clients (e.g. broadcaster and a
    // viewer) can race into this resume path concurrently, and each would
    // otherwise create its own separate in-memory session object — leaving
    // the broadcaster and viewers attached to different sessions.
    const raced = this.sessions.get(upper);
    if (raced) return raced;

    const resumed: LiveSession = {
      code: row.code,
      meta: { opponent: row.opponent, teamName: row.teamName },
      createdAt: row.createdAt.getTime(),
      broadcaster: null,
      viewers: new Map(),
      scoreboard: { teamScore: 0, opponentScore: 0 },
      recentEvents: [],
    };
    this.sessions.set(upper, resumed);
    try {
      await db
        .update(liveSessionsTable)
        .set({ lastSeenAt: new Date() })
        .where(eq(liveSessionsTable.code, upper));
    } catch (err) {
      logger.warn({ err, code: upper }, "Failed to refresh lastSeenAt on resumed live session");
    }
    logger.info({ code: upper }, "Resumed live session from persisted state after server restart");
    return resumed;
  }

  async endSession(code: string): Promise<void> {
    const upper = code.toUpperCase();
    const session = this.sessions.get(upper);
    if (session) {
      // Tell viewers the stream ended (with the final score and recent
      // stat events) BEFORE closing their sockets, so the watch page can
      // show a final-score summary instead of a bare "stream ended" note.
      const endedPayload = JSON.stringify({
        type: "stream-ended",
        teamScore: session.scoreboard.teamScore,
        opponentScore: session.scoreboard.opponentScore,
        events: session.recentEvents,
      });
      for (const viewerWs of session.viewers.values()) {
        try {
          if (viewerWs.readyState === viewerWs.OPEN) {
            viewerWs.send(endedPayload);
          }
          viewerWs.close();
        } catch {
          // ignore
        }
      }
      if (session.broadcaster) {
        try {
          session.broadcaster.close();
        } catch {
          // ignore
        }
      }
      this.sessions.delete(session.code);
    }
    this.lastHeartbeatAt.delete(upper);
    try {
      await db
        .update(liveSessionsTable)
        .set({ active: false, lastSeenAt: new Date() })
        .where(eq(liveSessionsTable.code, upper));
    } catch (err) {
      logger.error({ err, code: upper }, "Failed to mark persisted live session inactive");
    }
    logger.info({ code: upper }, "Live session ended");
  }

  /**
   * Purges old live_sessions rows so invite codes don't pile up forever:
   * - inactive (ended) sessions untouched for more than 3 days
   * - "active" sessions abandoned for more than 7 days (e.g. the coach never
   *   ended the stream and the server restarted, so no endSession ran)
   * Active or recently-ended sessions are never touched, so restart-resume
   * and rejoining a just-ended stream keep working.
   */
  async purgeOldSessions(): Promise<void> {
    const now = Date.now();
    const inactiveCutoff = new Date(now - 3 * 24 * 60 * 60 * 1000);
    const abandonedCutoff = new Date(now - 7 * 24 * 60 * 60 * 1000);
    try {
      const endedRows = await db
        .delete(liveSessionsTable)
        .where(and(eq(liveSessionsTable.active, false), lt(liveSessionsTable.lastSeenAt, inactiveCutoff)))
        .returning({ code: liveSessionsTable.code });
      const abandonedRows = await db
        .delete(liveSessionsTable)
        .where(and(eq(liveSessionsTable.active, true), lt(liveSessionsTable.lastSeenAt, abandonedCutoff)))
        .returning({ code: liveSessionsTable.code });
      for (const row of abandonedRows) {
        this.sessions.delete(row.code);
        this.lastHeartbeatAt.delete(row.code);
      }
      for (const row of endedRows) {
        this.lastHeartbeatAt.delete(row.code);
      }
      if (endedRows.length > 0 || abandonedRows.length > 0) {
        logger.info(
          { ended: endedRows.length, abandoned: abandonedRows.length },
          "Purged old live sessions from database",
        );
      }
    } catch (err) {
      logger.error({ err }, "Failed to purge old live sessions");
    }
  }

  startCleanupTimer(intervalMs = 60 * 60 * 1000): NodeJS.Timeout {
    void this.purgeOldSessions();
    const timer = setInterval(() => {
      void this.purgeOldSessions();
    }, intervalMs);
    timer.unref();
    return timer;
  }
}

export const liveStreamRegistry = new LiveStreamRegistry();
