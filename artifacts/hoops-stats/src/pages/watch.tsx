import { useEffect, useRef, useState } from "react";
import { useParams } from "wouter";
import { Radio, Users, Loader2, WifiOff, VolumeX, Share2, Check, X, RotateCw, Maximize2, Minimize2 } from "lucide-react";
import { getIceServers, liveWsUrl, getLiveStatus, type LiveStatus } from "@/lib/liveStream";

type ConnectionState = "connecting" | "waiting-for-broadcaster" | "live" | "reconnecting" | "ended" | "not-found";

type StatEvent = { id: string; playerName: string; label: string; timestamp: number };

const MAX_WATCH_RECONNECT_ATTEMPTS = 6;
const WATCH_RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 8000, 8000];

export default function WatchStream() {
  const params = useParams();
  const code = (params.code ?? "").toUpperCase();

  const [state, setState] = useState<ConnectionState>("connecting");
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [scoreboard, setScoreboard] = useState<{ teamScore: number; opponentScore: number } | null>(null);
  const [statEvents, setStatEvents] = useState<StatEvent[]>([]);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const myViewerIdRef = useRef<string | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const [muted, setMuted] = useState(true);
  const [shareStatus, setShareStatus] = useState<"idle" | "copied">("idle");

  // Pinch-to-zoom / pan / double-tap-reset — all via refs so gesture
  // handling never triggers a React re-render.
  const videoWrapRef = useRef<HTMLDivElement | null>(null);
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const pinchStartDistRef = useRef<number | null>(null);
  const panStartRef = useRef<{ x: number; y: number } | null>(null);
  const lastTapRef = useRef(0);

  const applyTransform = () => {
    const el = videoWrapRef.current;
    if (!el) return;
    const z = zoomRef.current;
    const { x, y } = panRef.current;
    el.style.transform = z === 1 ? "" : `scale(${z}) translate(${x}px,${y}px)`;
  };

  const resetZoom = () => {
    zoomRef.current = 1;
    panRef.current = { x: 0, y: 0 };
    applyTransform();
  };

  const pinchDist = (t: React.TouchList) =>
    Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      pinchStartDistRef.current = pinchDist(e.touches);
      panStartRef.current = null;
    } else if (e.touches.length === 1) {
      pinchStartDistRef.current = null;
      panStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      const now = Date.now();
      if (now - lastTapRef.current < 300) resetZoom();
      lastTapRef.current = now;
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 2 && pinchStartDistRef.current !== null) {
      const newDist = pinchDist(e.touches);
      const ratio = newDist / pinchStartDistRef.current;
      zoomRef.current = Math.min(5, Math.max(1, zoomRef.current * ratio));
      pinchStartDistRef.current = newDist;
      if (zoomRef.current <= 1) panRef.current = { x: 0, y: 0 };
      applyTransform();
    } else if (e.touches.length === 1 && zoomRef.current > 1 && panStartRef.current) {
      const dx = (e.touches[0].clientX - panStartRef.current.x) / zoomRef.current;
      const dy = (e.touches[0].clientY - panStartRef.current.y) / zoomRef.current;
      panRef.current = { x: panRef.current.x + dx, y: panRef.current.y + dy };
      panStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      applyTransform();
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (e.touches.length < 2) pinchStartDistRef.current = null;
    if (e.touches.length === 0) panStartRef.current = null;
    if (zoomRef.current <= 1) { zoomRef.current = 1; panRef.current = { x: 0, y: 0 }; applyTransform(); }
  };

  // The broadcaster's video keeps whatever orientation their phone/tablet was
  // in when they hit Record (see camera-canvas-pipeline notes in record.tsx)
  // — it can be portrait OR landscape. A viewer's phone orientation has
  // nothing to do with that; if the two don't match, `object-contain`
  // pillar/letterboxes the video down to a small strip (e.g. a portrait
  // stream viewed on a landscape phone renders as a narrow vertical sliver
  // with huge black bars, and the top scoreboard overlay ends up looking
  // like it's sitting directly on top of what little video is visible).
  // Tracking both the actual stream's native shape and the viewer's current
  // screen orientation lets us tell them exactly which way to turn their
  // phone to see the full picture, instead of leaving them to guess.
  const [videoNativeSize, setVideoNativeSize] = useState<{ width: number; height: number } | null>(null);
  const [screenIsPortrait, setScreenIsPortrait] = useState<boolean | null>(null);
  const [isTouchDevice, setIsTouchDevice] = useState(false);
  const [rotateTipDismissed, setRotateTipDismissed] = useState(false);
  const [fillMode, setFillMode] = useState(false);
  const [viewportSize, setViewportSize] = useState<{ w: number; h: number }>({
    w: typeof window !== "undefined" ? window.innerWidth : 375,
    h: typeof window !== "undefined" ? window.innerHeight : 812,
  });

  useEffect(() => {
    const onResize = () => setViewportSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Pixels of black letterbox at the top when video is object-contain.
  // Used to push the scoreboard pill into the black area so it doesn't
  // sit on top of actual court content.
  const letterboxTopPx = videoNativeSize && !fillMode
    ? (() => {
        const scale = Math.min(viewportSize.w / videoNativeSize.width, viewportSize.h / videoNativeSize.height);
        return Math.max(0, (viewportSize.h - videoNativeSize.height * scale) / 2);
      })()
    : 0;

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    // Only a touch device can actually act on "rotate your phone" — a
    // desktop viewer has no phone to turn, so we gate the tip on
    // pointer:coarse separately from the orientation query itself (which
    // must reflect the real screen orientation regardless of pointer type).
    const mqPortrait = window.matchMedia("(orientation: portrait)");
    const mqCoarse = window.matchMedia("(pointer: coarse)");
    setScreenIsPortrait(mqPortrait.matches);
    setIsTouchDevice(mqCoarse.matches);
    const onPortraitChange = (e: MediaQueryListEvent) => {
      setScreenIsPortrait(e.matches);
      setRotateTipDismissed(false);
    };
    const onCoarseChange = (e: MediaQueryListEvent) => setIsTouchDevice(e.matches);
    mqPortrait.addEventListener?.("change", onPortraitChange);
    mqCoarse.addEventListener?.("change", onCoarseChange);
    return () => {
      mqPortrait.removeEventListener?.("change", onPortraitChange);
      mqCoarse.removeEventListener?.("change", onCoarseChange);
    };
  }, []);

  const isVideoPortrait = videoNativeSize ? videoNativeSize.height >= videoNativeSize.width : null;
  const orientationMismatch =
    isTouchDevice &&
    screenIsPortrait !== null &&
    isVideoPortrait !== null &&
    screenIsPortrait !== isVideoPortrait;
  const showRotateTip = orientationMismatch && !rotateTipDismissed;

  const shareLink = async () => {
    const url = window.location.href;
    const title = status ? `Watch ${status.teamName} vs ${status.opponent} — Live` : "Watch Live Game";
    if (navigator.share) {
      try { await navigator.share({ title, url }); } catch { /* user cancelled */ }
    } else {
      await navigator.clipboard.writeText(url).catch(() => {});
      setShareStatus("copied");
      setTimeout(() => setShareStatus("idle"), 2000);
    }
  };

  const attachStream = () => {
    const v = videoRef.current;
    const stream = remoteStreamRef.current;
    if (!v || !stream || v.srcObject === stream) return;
    v.srcObject = stream;
    v.play().catch(() => {
      // Play was rejected — most commonly iOS Safari blocking unmuted
      // autoplay on a programmatic call after a stream reconnect. Fall back
      // to muted play so the video keeps running, then restore the "Tap for
      // sound" overlay so the viewer has a clear path back to audio.
      v.muted = true;
      setMuted(true);
      v.play().catch(() => {});
    });
  };

  const handleLoadedMetadata = () => {
    const v = videoRef.current;
    if (v && v.videoWidth > 0 && v.videoHeight > 0) {
      setVideoNativeSize({ width: v.videoWidth, height: v.videoHeight });
    }
  };

  const dismissRotateTip = () => setRotateTipDismissed(true);

  const unmute = () => {
    const v = videoRef.current;
    if (v) {
      v.muted = false;
      setMuted(false);
      v.play().catch(() => {});
    }
  };
  const [finalSummary, setFinalSummary] = useState<{
    teamScore: number;
    opponentScore: number;
    events: StatEvent[];
  } | null>(null);
  const explicitEndRef = useRef(false);
  const mediaFailedRef = useRef(false);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const attachConnectionStateHandlers = (pc: RTCPeerConnection) => {
    const handleConnectionStateChange = () => {
      const s = pc.connectionState;
      if (s === "connected") {
        mediaFailedRef.current = false;
        setState("live");
      } else if (s === "disconnected" || s === "failed") {
        // The broadcaster drives ICE restarts for this connection; while it
        // retries, show a clear "reconnecting" state instead of leaving a
        // frozen, silent frame on screen.
        setState((prev) => (prev === "ended" ? prev : "reconnecting"));
      }
    };
    pc.onconnectionstatechange = handleConnectionStateChange;
    pc.oniceconnectionstatechange = handleConnectionStateChange;
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

    const connect = (isReconnect: boolean) => {
      const ws = new WebSocket(liveWsUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "join-viewer", code }));
        mediaFailedRef.current = false;
        if (isReconnect) {
          reconnectAttemptsRef.current = 0;
          // Re-check status rather than assuming a broadcaster is present —
          // after an api-server restart the broadcaster may take longer to
          // reconnect than this viewer, in which case we should show
          // "waiting for broadcaster" instead of getting stuck on
          // "connecting" forever.
          setStatEvents([]);
          getLiveStatus(code).then((s) => {
            if (cancelled) return;
            if (s) {
              setStatus(s);
              setState(s.active ? "connecting" : "waiting-for-broadcaster");
            } else {
              setState("connecting");
            }
          });
        }
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

        if (message.type === "stat-events") {
          setStatEvents(Array.isArray(message.events) ? message.events : []);
          return;
        }

        if (message.type === "stat-event") {
          setStatEvents((prev) => [...prev, message.event].slice(-8));
          return;
        }

        if (message.type === "offer") {
          if (message.renegotiate && pcRef.current) {
            // ICE restart from the broadcaster on the existing peer
            // connection — reuse it instead of tearing down and rebuilding,
            // so media resumes as soon as connectivity is restored.
            const pc = pcRef.current;
            await pc.setRemoteDescription(new RTCSessionDescription(message.sdp));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            ws.send(JSON.stringify({ type: "answer", code, targetId: message.viewerId, sdp: answer }));
            return;
          }

          pcRef.current?.close();
          const iceServers = await getIceServers();
          const pc = new RTCPeerConnection({ iceServers });
          pcRef.current = pc;
          mediaFailedRef.current = false;

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

          attachConnectionStateHandlers(pc);

          await pc.setRemoteDescription(new RTCSessionDescription(message.sdp));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          ws.send(JSON.stringify({ type: "answer", code, targetId: message.viewerId, sdp: answer }));
        } else if (message.type === "ice-candidate") {
          if (pcRef.current && message.candidate) {
            await pcRef.current.addIceCandidate(new RTCIceCandidate(message.candidate));
          }
        } else if (message.type === "broadcaster-left" || message.type === "stream-ended") {
          // The coach explicitly ended the stream (as opposed to the
          // signaling server itself dropping the connection) — show
          // "ended" immediately rather than attempting to reconnect.
          // The server includes the final scoreboard and recent stat
          // events so we can show a final-score summary.
          explicitEndRef.current = true;
          setFinalSummary((prev) => {
            const hasScores =
              typeof message.teamScore === "number" && typeof message.opponentScore === "number";
            if (!hasScores) return prev;
            return {
              teamScore: message.teamScore,
              opponentScore: message.opponentScore,
              events: Array.isArray(message.events) ? message.events : [],
            };
          });
          setState("ended");
          pcRef.current?.close();
          pcRef.current = null;
        } else if (message.type === "peer-connection-failed") {
          // The broadcaster exhausted its ICE-restart attempts for our
          // media connection specifically. Show a clear "disconnected"
          // state instead of leaving a frozen, silent frame on screen.
          mediaFailedRef.current = true;
          setState("ended");
          pcRef.current?.close();
          pcRef.current = null;
        }
      };

      ws.onclose = () => {
        if (cancelled) return;
        pcRef.current?.close();
        pcRef.current = null;

        if (explicitEndRef.current) {
          setState("ended");
          return;
        }

        // Unexpected drop of the signaling connection — most commonly the
        // api-server restarting mid-game. The invite code is persisted
        // server-side, so keep retrying to rejoin the same session instead
        // of immediately declaring the stream over.
        if (reconnectAttemptsRef.current >= MAX_WATCH_RECONNECT_ATTEMPTS) {
          setState("ended");
          return;
        }

        setState("reconnecting");
        const delay = WATCH_RECONNECT_DELAYS_MS[reconnectAttemptsRef.current] ?? 8000;
        reconnectAttemptsRef.current += 1;
        reconnectTimeoutRef.current = setTimeout(() => {
          if (cancelled) return;
          connect(true);
        }, delay);
      };
    };

    connect(false);

    return () => {
      cancelled = true;
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      pcRef.current?.close();
      wsRef.current?.close();
    };
  }, [code]);

  useEffect(() => {
    if (state === "live") attachStream();
  }, [state]);

  return (
    <div
      className="fixed inset-0 bg-black flex items-center justify-center overflow-hidden"
      style={{ touchAction: "none" }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* Zoom wrapper — only this element scales; all overlays stay fixed above it */}
      <div
        ref={videoWrapRef}
        className="w-full h-full flex items-center justify-center will-change-transform"
        style={{ transformOrigin: "center center" }}
      >
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={muted}
          onLoadedMetadata={handleLoadedMetadata}
          className={`w-full h-full ${fillMode ? "object-cover" : "object-contain"} ${state === "live" ? "" : "invisible"}`}
        />
      </div>

      {state === "live" && showRotateTip && (
        <div
          className="absolute inset-x-3 z-10 flex items-center justify-between gap-3 rounded-lg bg-black/70 px-3 py-2 text-white backdrop-blur-sm"
          style={{ bottom: "calc(env(safe-area-inset-bottom) + 4rem)" }}
        >
          <span className="flex items-center gap-2 text-xs font-medium">
            <RotateCw className="w-4 h-4 shrink-0" />
            Turn your phone to {isVideoPortrait ? "portrait" : "landscape"} to see the full video.
          </span>
          <button
            type="button"
            onClick={dismissRotateTip}
            className="shrink-0 rounded-full p-1 hover:bg-white/20"
            aria-label="Dismiss tip"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {state === "live" && scoreboard && (
        // Deliberately NOT a full-width gradient wash behind this pill. That
        // used to paint a large dark band across the top of the frame
        // regardless of whether the video was letterboxed there or not — on
        // a viewer whose phone orientation matched the stream (no letterbox),
        // the band sat directly on top of real court action (e.g. the hoop),
        // which read as "the scoreboard is on top of the video" and was
        // distracting. The compact pill below carries its own opaque
        // background + blur, so it stays legible without darkening anything
        // beyond its own small footprint.
        <div
          className="absolute top-0 left-0 right-0 flex justify-center px-3 pointer-events-none"
          style={{ paddingTop: `calc(max(${Math.round(letterboxTopPx)}px, env(safe-area-inset-top)) + 0.75rem)` }}
        >
          <div className="flex items-center gap-3 rounded-xl border border-white/15 bg-black/80 px-4 py-2 backdrop-blur-md shadow-[0_4px_20px_rgba(0,0,0,0.65)]">
            <span className="font-display font-bold uppercase tracking-wide text-white text-sm md:text-base truncate max-w-[26vw] text-right leading-none">
              {status?.teamName ?? "Team"}
            </span>
            <span className="font-display font-bold text-3xl md:text-4xl tabular-nums shrink-0 text-primary leading-none drop-shadow-[0_0_10px_hsl(var(--primary)/0.6)]">
              {scoreboard.teamScore}<span className="mx-1.5 text-white/40">-</span>{scoreboard.opponentScore}
            </span>
            <span className="font-display font-bold uppercase tracking-wide text-white text-sm md:text-base truncate max-w-[26vw] text-left leading-none">
              {status?.opponent ?? "Opp"}
            </span>
            <span className="flex items-center gap-1 rounded-full bg-red-600/90 px-2 py-0.5 text-[10px] font-bold text-white shrink-0 ml-1">
              <Radio className="w-3 h-3" /> LIVE
            </span>
          </div>
        </div>
      )}

      {state === "live" && statEvents.length > 0 && (
        <div className="absolute left-2 top-24 flex flex-col gap-1.5 pointer-events-none max-w-[75%]">
          {statEvents.slice(-4).map((ev) => (
            <div
              key={ev.id}
              className="flex items-center gap-1.5 rounded-full bg-black/60 backdrop-blur-sm px-3 py-1.5 text-white text-xs font-semibold shadow-lg animate-in fade-in slide-in-from-left-2"
            >
              <span className="text-primary font-bold">{ev.label}</span>
              <span className="truncate">{ev.playerName}</span>
            </div>
          ))}
        </div>
      )}

      {state === "live" && (
        <div
          className="absolute left-3 right-3 flex items-center gap-2"
          style={{ bottom: "calc(env(safe-area-inset-bottom) + 0.75rem)" }}
        >
          <button
            onClick={shareLink}
            className="flex items-center gap-1.5 rounded-full bg-black/70 text-white text-sm font-semibold px-4 py-2 backdrop-blur-sm hover:bg-black/80 transition-colors"
          >
            {shareStatus === "copied"
              ? <><Check className="w-4 h-4 text-green-400" /> Copied!</>
              : <><Share2 className="w-4 h-4" /> Share</>}
          </button>
          <button
            onClick={() => {
              setFillMode(prev => {
                if (!prev) resetZoom();
                return !prev;
              });
            }}
            className="flex items-center gap-1.5 rounded-full bg-black/70 text-white text-sm font-semibold px-4 py-2 backdrop-blur-sm hover:bg-black/80 transition-colors"
            title={fillMode ? "Show full frame" : "Fill screen"}
          >
            {fillMode
              ? <><Minimize2 className="w-4 h-4" /> Fit</>
              : <><Maximize2 className="w-4 h-4" /> Fill</>}
          </button>
        </div>
      )}

      {state === "live" && muted && (
        <button
          onClick={unmute}
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/40 backdrop-blur-sm z-10"
          aria-label="Tap to unmute"
        >
          <div className="flex flex-col items-center gap-3 rounded-2xl bg-black/70 px-8 py-6 text-white backdrop-blur-md">
            <VolumeX className="w-10 h-10 text-white/80" />
            <span className="text-xl font-bold">Tap for sound</span>
            <span className="text-sm text-white/60">Browsers mute live video by default</span>
          </div>
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
              <p>Joining the stream...</p>
            </>
          )}
          {state === "waiting-for-broadcaster" && (
            <>
              <Users className="w-8 h-8 text-primary" />
              <p className="max-w-sm text-white">Game hasn't started yet. You're in the right place — it'll connect automatically when the coach goes live.</p>
              <button
                onClick={shareLink}
                className="mt-2 flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-5 py-2 text-sm font-semibold text-white backdrop-blur-sm hover:bg-white/20 transition-colors"
              >
                {shareStatus === "copied"
                  ? <><Check className="w-4 h-4 text-green-400" /> Link copied!</>
                  : <><Share2 className="w-4 h-4" /> Share with family</>}
              </button>
            </>
          )}
          {state === "reconnecting" && (
            <>
              <Loader2 className="w-8 h-8 animate-spin" />
              <p className="max-w-sm">Reconnecting... stay on this page.</p>
            </>
          )}
          {state === "ended" && (() => {
            const summary =
              finalSummary ??
              (explicitEndRef.current && scoreboard
                ? { teamScore: scoreboard.teamScore, opponentScore: scoreboard.opponentScore, events: statEvents }
                : null);
            return (
              <>
                {summary ? (
                  <div className="flex flex-col items-center gap-4 w-full max-w-sm">
                    <span className="text-xs font-bold uppercase tracking-widest text-white/50">Final Score</span>
                    <div className="flex items-center gap-4 rounded-xl border border-white/15 bg-white/5 px-6 py-4 backdrop-blur-md">
                      <span className="font-display font-bold uppercase tracking-wide text-white text-sm md:text-base truncate max-w-[26vw] text-right leading-none">
                        {status?.teamName ?? "Team"}
                      </span>
                      <span className="font-display font-bold text-4xl md:text-5xl tabular-nums shrink-0 text-primary leading-none drop-shadow-[0_0_10px_hsl(var(--primary)/0.6)]">
                        {summary.teamScore}<span className="mx-1.5 text-white/40">-</span>{summary.opponentScore}
                      </span>
                      <span className="font-display font-bold uppercase tracking-wide text-white text-sm md:text-base truncate max-w-[26vw] text-left leading-none">
                        {status?.opponent ?? "Opp"}
                      </span>
                    </div>
                    {summary.events.length > 0 && (
                      <div className="w-full">
                        <p className="text-xs font-bold uppercase tracking-widest text-white/50 mb-2">Last Plays</p>
                        <ul className="flex flex-col gap-1.5">
                          {summary.events.slice(-5).reverse().map((ev) => (
                            <li
                              key={ev.id}
                              className="flex items-center gap-2 rounded-lg bg-white/5 px-3 py-1.5 text-white text-xs font-semibold"
                            >
                              <span className="text-primary font-bold shrink-0">{ev.label}</span>
                              <span className="truncate">{ev.playerName}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    <p className="text-sm text-white/60">The game has ended.</p>
                    <button
                      onClick={shareLink}
                      className="mt-2 flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-5 py-2 text-sm font-semibold text-white hover:bg-white/20 transition-colors"
                    >
                      {shareStatus === "copied"
                        ? <><Check className="w-4 h-4 text-green-400" /> Link copied!</>
                        : <><Share2 className="w-4 h-4" /> Share this game</>}
                    </button>
                  </div>
                ) : (
                  <>
                    <WifiOff className="w-8 h-8" />
                    <p className="max-w-sm text-white">
                      {explicitEndRef.current
                        ? "The game has ended."
                        : "Connection dropped and couldn't be restored."}
                    </p>
                    {!explicitEndRef.current && (
                      <button
                        onClick={() => window.location.reload()}
                        className="mt-2 rounded-full border border-white/20 bg-white/10 px-5 py-2 text-sm font-semibold text-white hover:bg-white/20 transition-colors"
                      >
                        Refresh and try again
                      </button>
                    )}
                    {explicitEndRef.current && (
                      <button
                        onClick={shareLink}
                        className="mt-2 flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-5 py-2 text-sm font-semibold text-white hover:bg-white/20 transition-colors"
                      >
                        {shareStatus === "copied"
                          ? <><Check className="w-4 h-4 text-green-400" /> Link copied!</>
                          : <><Share2 className="w-4 h-4" /> Share this game</>}
                      </button>
                    )}
                  </>
                )}
              </>
            );
          })()}
          {state === "not-found" && (
            <>
              <WifiOff className="w-8 h-8" />
              <p className="max-w-sm">This link has expired or isn't valid. Ask the coach for a new one.</p>
            </>
          )}
          <p className="text-xs text-white/40 mt-4">No account needed to watch.</p>
        </div>
      )}
    </div>
  );
}
