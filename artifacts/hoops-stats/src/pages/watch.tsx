import { useEffect, useRef, useState } from "react";
import { useParams } from "wouter";
import { Radio, Users, Loader2, WifiOff } from "lucide-react";
import { STUN_SERVERS, liveWsUrl, getLiveStatus, type LiveStatus } from "@/lib/liveStream";

type ConnectionState = "connecting" | "waiting-for-broadcaster" | "live" | "ended" | "not-found";

export default function WatchStream() {
  const params = useParams();
  const code = (params.code ?? "").toUpperCase();

  const [state, setState] = useState<ConnectionState>("connecting");
  const [status, setStatus] = useState<LiveStatus | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const myViewerIdRef = useRef<string | null>(null);

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

      if (message.type === "offer") {
        const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
        pcRef.current = pc;

        pc.ontrack = (e) => {
          if (videoRef.current) {
            videoRef.current.srcObject = e.streams[0];
            videoRef.current.play().catch(() => {});
          }
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

  return (
    <div className="min-h-screen bg-secondary flex flex-col items-center justify-center p-4 gap-6">
      <div className="w-full max-w-2xl space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-display font-bold uppercase tracking-tight text-secondary-foreground">
            {status ? `${status.teamName} vs ${status.opponent}` : "Live Game"}
          </h1>
          {state === "live" && (
            <span className="flex items-center gap-1 text-sm font-semibold text-red-500">
              <Radio className="w-4 h-4" /> LIVE
            </span>
          )}
        </div>

        <div className="w-full aspect-video bg-black rounded-lg overflow-hidden flex items-center justify-center">
          {state === "live" ? (
            <video ref={videoRef} autoPlay playsInline className="w-full h-full" />
          ) : (
            <div className="text-center text-white/70 flex flex-col items-center gap-3 p-6">
              {state === "connecting" && (
                <>
                  <Loader2 className="w-8 h-8 animate-spin" />
                  <p>Connecting to the stream...</p>
                </>
              )}
              {state === "waiting-for-broadcaster" && (
                <>
                  <Users className="w-8 h-8" />
                  <p>The coach hasn't started streaming yet. Stay on this page — it will connect automatically.</p>
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
            </div>
          )}
        </div>

        <p className="text-sm text-secondary-foreground/60 text-center">
          You're watching via a private invite link. No account needed.
        </p>
      </div>
    </div>
  );
}
