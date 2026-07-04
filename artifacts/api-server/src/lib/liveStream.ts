import type { WebSocket } from "ws";
import { logger } from "./logger";

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
