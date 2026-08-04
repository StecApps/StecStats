import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import { nanoid } from "nanoid";
import { liveStreamRegistry, MAX_RECENT_STAT_EVENTS } from "./liveStream";
import { logger } from "./logger";

const LIVE_WS_PATH = "/api/live/ws";

type ClientMessage =
  | { type: "join-broadcaster"; code: string; teamScore?: number; opponentScore?: number }
  | { type: "join-viewer"; code: string }
  | { type: "offer"; code: string; targetId: string; sdp: unknown; renegotiate?: boolean }
  | { type: "answer"; code: string; targetId: string; sdp: unknown }
  | { type: "ice-candidate"; code: string; targetId: string; candidate: unknown }
  | { type: "scoreboard"; code: string; teamScore: number; opponentScore: number }
  | { type: "stat-event"; code: string; playerName: string; label: string }
  | { type: "resync-events"; code: string; events: Array<{ playerName: string; label: string; timestamp: number }> }
  | { type: "peer-connection-failed"; code: string; targetId: string }
  | { type: "request-offer"; code: string }
  | { type: "turn-status"; code: string; turnAvailable: boolean };

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
    // Keep the signaling socket alive through idle periods (e.g. no stat taps,
    // no new viewers). Mobile networks and reverse-proxy idle-timeouts typically
    // kill TCP connections after 60-90 s of silence. Sending a WebSocket-level
    // ping every 25 s ensures continuous traffic; browsers respond with a pong
    // frame automatically (no client code required). If a pong is not received
    // before the next ping, the socket is already dead and gets terminated so
    // the server can clean up its viewer/broadcaster slot promptly.
    let isAlive = true;
    ws.on("pong", () => { isAlive = true; });
    const pingInterval = setInterval(() => {
      if (!isAlive) {
        ws.terminate();
        clearInterval(pingInterval);
        return;
      }
      isAlive = false;
      try { ws.ping(); } catch { /* socket already closing */ }
    }, 25_000);
    ws.on("close", () => clearInterval(pingInterval));

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

      // Heartbeat: any live signaling activity keeps the persisted session
      // fresh so the cleanup job never mistakes an ongoing stream for an
      // abandoned one (throttled internally).
      liveStreamRegistry.touchSession(session.code);

      switch (message.type) {
        case "join-broadcaster": {
          session.broadcaster = ws;
          role = "broadcaster";
          sessionCode = session.code;
          // If the broadcaster sends its current scores on (re)connect, update
          // the in-memory scoreboard immediately.  This corrects the 0-0 reset
          // that happens when the server restarts and rebuilds the session from
          // the database — any viewers who join (or rejoin) after the restart
          // will receive the real score in their initial scoreboard snapshot.
          if (
            typeof message.teamScore === "number" &&
            typeof message.opponentScore === "number"
          ) {
            const teamScore = Math.max(0, Math.round(message.teamScore));
            const opponentScore = Math.max(0, Math.round(message.opponentScore));
            session.scoreboard = { teamScore, opponentScore };
            for (const viewerWs of session.viewers.values()) {
              safeSend(viewerWs, { type: "scoreboard", teamScore, opponentScore });
            }
          }
          for (const [id] of session.viewers) {
            safeSend(ws, { type: "new-viewer", viewerId: id });
          }
          // Ack so the broadcaster knows it is fully registered and can safely
          // send resync-events.  Without this ack the client sends resync-events
          // immediately after join-broadcaster on ws.onopen; because
          // getOrResumeSession() is async both messages race and resync-events
          // can arrive before role/session.broadcaster are set, causing it to
          // be silently dropped.
          safeSend(ws, { type: "broadcaster-joined" });
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
          safeSend(ws, { type: "stat-events", events: session.recentEvents });
          if (session.broadcaster) {
            safeSend(session.broadcaster, { type: "new-viewer", viewerId });
          }
          break;
        }
        case "offer": {
          const target = session.viewers.get(message.targetId);
          if (target) {
            safeSend(target, {
              type: "offer",
              sdp: message.sdp,
              viewerId: message.targetId,
              renegotiate: message.renegotiate === true,
            });
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
        case "stat-event": {
          if (role !== "broadcaster") break;
          const playerName = String(message.playerName ?? "").slice(0, 80);
          const label = String(message.label ?? "").slice(0, 40);
          if (!playerName || !label) break;
          const statEvent = { id: nanoid(8), playerName, label, timestamp: Date.now() };
          session.recentEvents = [...session.recentEvents, statEvent].slice(-MAX_RECENT_STAT_EVENTS);
          for (const viewerWs of session.viewers.values()) {
            safeSend(viewerWs, { type: "stat-event", event: statEvent });
          }
          break;
        }
        case "resync-events": {
          // The broadcaster re-sends its local event log on every (re)connect
          // so the server's recentEvents list is repopulated after a restart
          // instead of staying empty until new stats are tapped.
          if (role !== "broadcaster") break;
          if (!Array.isArray(message.events) || message.events.length === 0) break;
          const incoming = message.events
            .filter((e) => typeof e.playerName === "string" && typeof e.label === "string")
            .slice(-MAX_RECENT_STAT_EVENTS)
            .map((e) => ({
              id: nanoid(8),
              playerName: String(e.playerName).slice(0, 80),
              label: String(e.label).slice(0, 40),
              // Preserve the original client-side timestamp so relative ordering
              // is correct on the viewer ticker; fall back to now only when absent.
              timestamp: typeof e.timestamp === "number" ? e.timestamp : Date.now(),
            }));
          if (incoming.length === 0) break;
          session.recentEvents = incoming;
          // Push the repopulated list to every viewer currently watching so
          // their ticker fills in immediately without a page reload.
          for (const viewerWs of session.viewers.values()) {
            safeSend(viewerWs, { type: "stat-events", events: session.recentEvents });
          }
          break;
        }
        case "peer-connection-failed": {
          // The broadcaster exhausted its ICE-restart attempts for this
          // specific viewer's media connection. Let that viewer know so it
          // can show a clear "disconnected" state instead of a frozen
          // silent video.
          if (role !== "broadcaster") break;
          const target = session.viewers.get(message.targetId);
          if (target) {
            safeSend(target, { type: "peer-connection-failed" });
          }
          break;
        }
        case "request-offer": {
          // A viewer's ICE negotiation timed out without reaching "connected"
          // (common on restrictive gym networks where ICE hangs in "checking"
          // without ever firing "failed"). Ask the broadcaster to send a
          // fresh offer to this same viewer ID so we don't create a duplicate
          // entry in the viewer map.
          if (role !== "viewer" || !viewerId || !session.broadcaster) break;
          safeSend(session.broadcaster, { type: "new-viewer", viewerId });
          break;
        }
        case "turn-status": {
          // The broadcaster's periodic TURN health-check detected a change in
          // relay availability. Fan the status out to every current viewer so
          // restricted-network viewers can show a self-diagnostic banner
          // instead of silently losing the stream.
          if (role !== "broadcaster") break;
          const turnAvailable = message.turnAvailable === true;
          for (const viewerWs of session.viewers.values()) {
            safeSend(viewerWs, { type: "turn-status", turnAvailable });
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
        // Include the final scoreboard and recent stat events so the watch
        // page can show a final-score summary on its "ended" screen.
        for (const viewerWs of session.viewers.values()) {
          safeSend(viewerWs, {
            type: "broadcaster-left",
            teamScore: session.scoreboard.teamScore,
            opponentScore: session.scoreboard.opponentScore,
            events: session.recentEvents,
          });
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
