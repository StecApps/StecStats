import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import { nanoid } from "nanoid";
import { liveStreamRegistry } from "./liveStream";
import { logger } from "./logger";

const LIVE_WS_PATH = "/api/live/ws";

type ClientMessage =
  | { type: "join-broadcaster"; code: string }
  | { type: "join-viewer"; code: string }
  | { type: "offer"; code: string; targetId: string; sdp: unknown }
  | { type: "answer"; code: string; targetId: string; sdp: unknown }
  | { type: "ice-candidate"; code: string; targetId: string; candidate: unknown }
  | { type: "scoreboard"; code: string; teamScore: number; opponentScore: number };

function safeSend(ws: WebSocket, payload: unknown) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

export function attachLiveSocketServer(upgradeEmitter: {
  on(event: "upgrade", listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): void;
}) {
  const wss = new WebSocketServer({ noServer: true });

  upgradeEmitter.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "", "http://localhost");
    if (url.pathname !== LIVE_WS_PATH) {
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: WebSocket) => {
    let role: "broadcaster" | "viewer" | null = null;
    let sessionCode: string | null = null;
    let viewerId: string | null = null;

    ws.on("message", async (raw: RawData) => {
      let message: ClientMessage;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // Resume-aware lookup: if the api-server restarted mid-game, the
      // in-memory session is gone but its code/metadata were persisted, so
      // this transparently recreates the in-memory shell and lets the
      // broadcaster/viewer rejoin the same session instead of hitting a
      // dead "stream not found" error.
      const session = await liveStreamRegistry.getOrResumeSession(message.code);
      if (!session) {
        safeSend(ws, { type: "error", message: "Stream not found" });
        return;
      }

      switch (message.type) {
        case "join-broadcaster": {
          session.broadcaster = ws;
          role = "broadcaster";
          sessionCode = session.code;
          for (const [id] of session.viewers) {
            safeSend(ws, { type: "new-viewer", viewerId: id });
          }
          break;
        }
        case "join-viewer": {
          viewerId = nanoid(8);
          session.viewers.set(viewerId, ws);
          role = "viewer";
          sessionCode = session.code;
          safeSend(ws, { type: "joined", viewerId });
          safeSend(ws, {
            type: "scoreboard",
            teamScore: session.scoreboard.teamScore,
            opponentScore: session.scoreboard.opponentScore,
          });
          if (session.broadcaster) {
            safeSend(session.broadcaster, { type: "new-viewer", viewerId });
          }
          break;
        }
        case "offer": {
          const target = session.viewers.get(message.targetId);
          if (target) {
            safeSend(target, { type: "offer", sdp: message.sdp, viewerId: message.targetId });
          }
          break;
        }
        case "answer": {
          if (session.broadcaster) {
            safeSend(session.broadcaster, {
              type: "answer",
              sdp: message.sdp,
              viewerId: message.targetId,
            });
          }
          break;
        }
        case "ice-candidate": {
          if (message.targetId === "broadcaster") {
            if (session.broadcaster) {
              safeSend(session.broadcaster, {
                type: "ice-candidate",
                candidate: message.candidate,
                viewerId,
              });
            }
          } else {
            const target = session.viewers.get(message.targetId);
            if (target) {
              safeSend(target, { type: "ice-candidate", candidate: message.candidate });
            }
          }
          break;
        }
        case "scoreboard": {
          if (role !== "broadcaster") break;
          const teamScore = Math.max(0, Math.round(Number(message.teamScore) || 0));
          const opponentScore = Math.max(0, Math.round(Number(message.opponentScore) || 0));
          session.scoreboard = { teamScore, opponentScore };
          for (const viewerWs of session.viewers.values()) {
            safeSend(viewerWs, { type: "scoreboard", teamScore, opponentScore });
          }
          break;
        }
      }
    });

    ws.on("close", () => {
      if (!sessionCode) return;
      const session = liveStreamRegistry.getSession(sessionCode);
      if (!session) return;

      if (role === "broadcaster" && session.broadcaster === ws) {
        session.broadcaster = null;
        for (const viewerWs of session.viewers.values()) {
          safeSend(viewerWs, { type: "broadcaster-left" });
        }
        logger.info({ code: sessionCode }, "Broadcaster disconnected from live session");
      } else if (role === "viewer" && viewerId) {
        session.viewers.delete(viewerId);
        if (session.broadcaster) {
          safeSend(session.broadcaster, { type: "viewer-left", viewerId });
        }
      }
    });
  });

  return wss;
}
