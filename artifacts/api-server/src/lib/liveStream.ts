import type { WebSocket } from "ws";
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

export type LiveSession = {
  code: string;
  meta: LiveSessionMeta;
  createdAt: number;
  broadcaster: WebSocket | null;
  viewers: Map<string, WebSocket>;
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

  createSession(meta: LiveSessionMeta): LiveSession {
    let code = generateCode();
    while (this.sessions.has(code)) {
      code = generateCode();
    }
    const session: LiveSession = {
      code,
      meta,
      createdAt: Date.now(),
      broadcaster: null,
      viewers: new Map(),
    };
    this.sessions.set(code, session);
    return session;
  }

  getSession(code: string): LiveSession | undefined {
    return this.sessions.get(code.toUpperCase());
  }

  endSession(code: string): void {
    const session = this.sessions.get(code.toUpperCase());
    if (!session) return;
    for (const viewerWs of session.viewers.values()) {
      try {
        viewerWs.close();
      } catch {
        // ignore
      }
    }
    this.sessions.delete(session.code);
    logger.info({ code: session.code }, "Live session ended");
  }
}

export const liveStreamRegistry = new LiveStreamRegistry();
