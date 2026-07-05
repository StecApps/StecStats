import type { WebSocket } from "ws";
import { eq } from "drizzle-orm";
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

export type LiveSession = {
  code: string;
  meta: LiveSessionMeta;
  createdAt: number;
  broadcaster: WebSocket | null;
  viewers: Map<string, WebSocket>;
  scoreboard: Scoreboard;
};

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateCode(length = 6): string {
  let code = "";
  for (let i = 0; i < length; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

class LiveStreamRegistry {
  private sessions = new Map<string, LiveSession>();

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

    const resumed: LiveSession = {
      code: row.code,
      meta: { opponent: row.opponent, teamName: row.teamName },
      createdAt: row.createdAt.getTime(),
      broadcaster: null,
      viewers: new Map(),
    };
    this.sessions.set(upper, resumed);
    logger.info({ code: upper }, "Resumed live session from persisted state after server restart");
    return resumed;
  }

  async endSession(code: string): Promise<void> {
    const upper = code.toUpperCase();
    const session = this.sessions.get(upper);
    if (session) {
      for (const viewerWs of session.viewers.values()) {
        try {
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
    try {
      await db.update(liveSessionsTable).set({ active: false }).where(eq(liveSessionsTable.code, upper));
    } catch (err) {
      logger.error({ err, code: upper }, "Failed to mark persisted live session inactive");
    }
    logger.info({ code: upper }, "Live session ended");
  }
}

export const liveStreamRegistry = new LiveStreamRegistry();
