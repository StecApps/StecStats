import { useEffect, useRef, useState } from "react";
import { useParams } from "wouter";
import { Radio, Users, Loader2, WifiOff, VolumeX } from "lucide-react";
import { getIceServers, liveWsUrl, getLiveStatus, type LiveStatus } from "@/lib/liveStream";

type ConnectionState = "connecting" | "waiting-for-broadcaster" | "live" | "ended" | "not-found";

export default function WatchStream() {
  const params = useParams();
  const code = (params.code ?? "").toUpperCase();

  const [state, setState] = useState<ConnectionState>("connecting");
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [scoreboard, setScoreboard] = useState<{ teamScore: number; opponentScore: number } | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const myViewerIdRef = useRef<string | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const [muted, setMuted] = useState(true);

  const attachStream = () => {
    const v = videoRef.current;
    const stream = remoteStreamRef.current;
    if (v && stream && v.srcObject !== stream) {
      v.srcObject = stream;
      v.play().catch(() => {});
    }
  };

  const unmute = () => {
    const v = videoRef.current;
    if (v) {
      v.muted = false;
      setMuted(false);
      v.play().catch(() => {});
    }
  };

  useEffect(() => {
    if (!code) return;

    let cancelled = false;

    getLiveStatus(code).then((s) => {
      if (cancelled) return;
      if (!s) {
        setState("not-found");
        return;
      }
      setStatus(s);
      setScoreboard({ teamScore: s.teamScore, opponentScore: s.opponentScore });
      setState(s.active ? "connecting" : "waiting-for-broadcaster");
    });

    const ws = new WebSocket(liveWsUrl());
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "join-viewer", code }));
    };

    ws.onmessage = async (event) => {
      const message = JSON.parse(event.data);

      if (message.type === "error") {
        setState("not-found");
        return;
      }

      if (message.type === "joined") {
        myViewerIdRef.current = message.viewerId;
        return;
      }

      if (message.type === "scoreboard") {
        setScoreboard({ teamScore: message.teamScore, opponentScore: message.opponentScore });
        return;
      }

      if (message.type === "offer") {
        const iceServers = await getIceServers();
        const pc = new RTCPeerConnection({ iceServers });
        pcRef.current = pc;

        pc.ontrack = (e) => {
          remoteStreamRef.current = e.streams[0] ?? new MediaStream([e.track]);
          attachStream();
          setState("live");
        };

        pc.onicecandidate = (e) => {
          if (e.candidate && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: "ice-candidate",
              code,
              targetId: "broadcaster",
              candidate: e.candidate,
            }));
          }
        };

        await pc.setRemoteDescription(new RTCSessionDescription(message.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        ws.send(JSON.stringify({ type: "answer", code, targetId: message.viewerId, sdp: answer }));
      } else if (message.type === "ice-candidate") {
        if (pcRef.current && message.candidate) {
          await pcRef.current.addIceCandidate(new RTCIceCandidate(message.candidate));
        }
      } else if (message.type === "broadcaster-left") {
        setState("ended");
        pcRef.current?.close();
        pcRef.current = null;
      }
    };

    ws.onclose = () => {
      if (!cancelled) {
        setState((prev) => (prev === "live" ? "ended" : prev));
      }
    };

    return () => {
      cancelled = true;
      pcRef.current?.close();
      ws.close();
    };
  }, [code]);

  useEffect(() => {
    if (state === "live") attachStream();
  }, [state]);

  return (
    <div className="fixed inset-0 bg-black flex items-center justify-center overflow-hidden">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={muted}
        className={`w-full h-full object-contain ${state === "live" ? "" : "invisible"}`}
      />

      {state === "live" && scoreboard && (
        <div
          className="absolute top-0 left-0 right-0 flex items-center justify-center gap-3 bg-gradient-to-b from-black/80 via-black/45 to-transparent px-3 pb-8 text-white pointer-events-none"
          style={{ paddingTop: "calc(env(safe-area-inset-top) + 0.5rem)" }}
        >
          <span className="text-xs font-bold uppercase tracking-wide truncate max-w-[30%] text-right">
            {status?.teamName ?? "Team"}
          </span>
          <span className="font-mono font-bold text-xl tabular-nums shrink-0">
            {scoreboard.teamScore}<span className="mx-1.5 opacity-60">-</span>{scoreboard.opponentScore}
          </span>
          <span className="text-xs font-bold uppercase tracking-wide truncate max-w-[30%] text-left">
            {status?.opponent ?? "Opp"}
          </span>
          <span className="flex items-center gap-1 text-[11px] font-bold text-red-500 shrink-0 ml-1">
            <Radio className="w-3 h-3" /> LIVE
          </span>
        </div>
      )}

      {state === "live" && muted && (
        <button
          onClick={unmute}
          className="absolute right-3 flex items-center gap-1.5 rounded-full bg-black/70 text-white text-sm font-semibold px-4 py-2 backdrop-blur-sm hover:bg-black/80"
          style={{ bottom: "calc(env(safe-area-inset-bottom) + 0.75rem)" }}
        >
          <VolumeX className="w-4 h-4" /> Tap for sound
        </button>
      )}

      {state !== "live" && (
        <div className="absolute inset-0 text-center text-white/80 flex flex-col items-center justify-center gap-3 p-6">
          <h1 className="text-xl font-display font-bold uppercase tracking-tight mb-2">
            {status ? `${status.teamName} vs ${status.opponent}` : "Live Game"}
          </h1>
          {state === "connecting" && (
            <>
              <Loader2 className="w-8 h-8 animate-spin" />
              <p>Connecting to the stream...</p>
            </>
          )}
          {state === "waiting-for-broadcaster" && (
            <>
              <Users className="w-8 h-8" />
              <p className="max-w-sm">The coach hasn't started streaming yet. Stay on this page — it will connect automatically.</p>
            </>
          )}
          {state === "ended" && (
            <>
              <WifiOff className="w-8 h-8" />
              <p>This live stream has ended.</p>
            </>
          )}
          {state === "not-found" && (
            <>
              <WifiOff className="w-8 h-8" />
              <p>This invite link is no longer valid.</p>
            </>
          )}
          <p className="text-xs text-white/40 mt-4">You're watching via a private invite link. No account needed.</p>
        </div>
      )}
    </div>
  );
}
