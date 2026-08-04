import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "wouter";
import { Radio, Users, Loader2, WifiOff, VolumeX, Share2, Check, X, RotateCw, Maximize2, Minimize2, RefreshCw, AlertTriangle } from "lucide-react";
import { getIceServers, liveWsUrl, getLiveStatus, type LiveStatus } from "@/lib/liveStream";

type ConnectionState = "connecting" | "waiting-for-broadcaster" | "live" | "reconnecting" | "ended" | "not-found";

type StatEvent = { id: string; playerName: string; label: string; timestamp: number };

const MAX_WATCH_RECONNECT_ATTEMPTS = 6;
const WATCH_RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 8000, 8000];

export default function WatchStream() {
  const params = useParams();
  const code = (params.code ?? "").toUpperCase();

  // Test-mode overrides: ?__watchElapsedS=N reduces the "Still connecting…" timer
  // threshold and ?__watchRetryS=N reduces the "Tap to retry" threshold. These
  // are intentionally only read on mount so they don't interfere with production
  // rendering (the params won't be present in normal use).
  const searchParams = new URLSearchParams(
    typeof window !== "undefined" ? window.location.search : ""
  );
  const ELAPSED_THRESHOLD_S = Number(searchParams.get("__watchElapsedS") ?? "5");
  const RETRY_THRESHOLD_S   = Number(searchParams.get("__watchRetryS")   ?? "45");

  const [state, setState] = useState<ConnectionState>("connecting");
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [scoreboard, setScoreboard] = useState<{ teamScore: number; opponentScore: number } | null>(null);
  const [statEvents, setStatEvents] = useState<StatEvent[]>([]);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const myViewerIdRef = useRef<string | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const iceWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tracks whether an offer arrives after we send request-offer. If it
  // doesn't fire within 30 s the broadcaster is likely offline, so we
  // fall back to "waiting-for-broadcaster" instead of retrying forever.
  const offerWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Connecting-screen elapsed timers and retry counter.
  // connectingElapsed  — per-attempt seconds (resets on each ICE retry)
  // connectingTotal    — cumulative seconds since first entering "connecting" (never reset by retries)
  const [connectingElapsed, setConnectingElapsed] = useState(0);
  const [connectingTotal, setConnectingTotal] = useState(0);
  const [iceRetryCount, setIceRetryCount] = useState(0);
  const iceRetryCountRef = useRef(0); // mirror for use inside closures
  // WS-level reconnect progress — shown while state === "reconnecting".
  const [reconnectAttemptCount, setReconnectAttemptCount] = useState(0);
  const [reconnectElapsedSec, setReconnectElapsedSec] = useState(0);
  // Countdown to the next retry attempt ("next attempt in Ns").
  const [reconnectCountdownSec, setReconnectCountdownSec] = useState(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectStartRef = useRef<number | null>(null);
  // Absolute timestamp (ms) when the next WS reconnect attempt will fire.
  const reconnectRetryAtRef = useRef<number>(0);
  const connectingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const connectingAttemptStartRef = useRef<number | null>(null); // resets per attempt
  const connectingFirstStartRef = useRef<number | null>(null);   // set once, never reset

  const [muted, setMuted] = useState(true);
  const userUnmutedRef = useRef(false); // tracks if the viewer explicitly tapped to unmute
  const [shareStatus, setShareStatus] = useState<"idle" | "copied">("idle");

  // TURN relay self-diagnostic banner: shown when the broadcaster's health-check
  // reports the relay is down, cleared automatically when it recovers.
  const [turnRelayDown, setTurnRelayDown] = useState(false);
  const [turnBannerDismissed, setTurnBannerDismissed] = useState(false);

  // Pinch-to-zoom / pan / double-tap-reset — all via refs so gesture
  // handling never triggers a React re-render.
  const videoWrapRef = useRef<HTMLDivElement | null>(null);
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const pinchStartDistRef = useRef<number | null>(null);
  const panStartRef = useRef<{ x: number; y: number } | null>(null);
  const lastTapRef = useRef(0);

  // Format seconds as M:SS for the connecting timer display.
  const formatElapsed = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  };

  // Start (or restart) the connecting timers.
  // isFirstAttempt=true  → also reset the cumulative "total" timer (state just entered "connecting")
  // isFirstAttempt=false → keep cumulative running; only reset the per-attempt counter
  const startConnectingTimer = (isFirstAttempt: boolean) => {
    if (connectingTimerRef.current) clearInterval(connectingTimerRef.current);
    const attemptStart = Date.now();
    connectingAttemptStartRef.current = attemptStart;
    setConnectingElapsed(0);
    if (isFirstAttempt) {
      connectingFirstStartRef.current = attemptStart;
      setConnectingTotal(0);
    }
    connectingTimerRef.current = setInterval(() => {
      const now = Date.now();
      setConnectingElapsed(Math.floor((now - attemptStart) / 1000));
      if (connectingFirstStartRef.current !== null) {
        setConnectingTotal(Math.floor((now - connectingFirstStartRef.current) / 1000));
      }
    }, 1000);
  };

  const stopConnectingTimer = () => {
    if (connectingTimerRef.current) {
      clearInterval(connectingTimerRef.current);
      connectingTimerRef.current = null;
    }
    connectingAttemptStartRef.current = null;
    connectingFirstStartRef.current = null;
  };

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
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerSize, setContainerSize] = useState<{ w: number; h: number }>({ w: 375, h: 812 });

  // Use ResizeObserver on the actual container so the measurement is
  // accurate on iOS Safari where window.innerHeight doesn't match the
  // visible area due to browser chrome (URL bar, tab bar, etc.).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      setContainerSize({ w: width, h: height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Compute how many px of black bar sit on each axis when the video is
  // object-contain inside the container. Both values are 0 when the video
  // aspect ratio matches the container (one axis will always be 0).
  const { letterboxTop, letterboxLeft } = useMemo(() => {
    if (!videoNativeSize || fillMode) return { letterboxTop: 0, letterboxLeft: 0 };
    const scale = Math.min(containerSize.w / videoNativeSize.width, containerSize.h / videoNativeSize.height);
    return {
      letterboxTop: Math.max(0, (containerSize.h - videoNativeSize.height * scale) / 2),
      letterboxLeft: Math.max(0, (containerSize.w - videoNativeSize.width * scale) / 2),
    };
  }, [videoNativeSize, containerSize, fillMode]);

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
    // If the viewer already explicitly tapped to unmute, restore that state
    // on reconnect — browsers allow unmuted play after a prior user gesture.
    if (userUnmutedRef.current) {
      v.muted = false;
      setMuted(false);
    }
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
    userUnmutedRef.current = true;
    const v = videoRef.current;
    if (v) {
      v.muted = false;
      setMuted(false);
      v.play().catch(() => {});
    }
  };
  // Drive the elapsed timers based on connection state.
  useEffect(() => {
    if (state === "connecting") {
      // Only start the timers if not already running (avoid resetting on
      // unrelated re-renders). The watchdog resets per-attempt time explicitly.
      if (connectingTimerRef.current === null) {
        startConnectingTimer(true /* first attempt */);
      }
    } else {
      stopConnectingTimer();
      if (state === "live") {
        // Reset all counters once we're actually connected.
        setIceRetryCount(0);
        iceRetryCountRef.current = 0;
        setConnectingElapsed(0);
        setConnectingTotal(0);
        setReconnectAttemptCount(0);
      }
    }
  }, [state]); // eslint-disable-line react-hooks/exhaustive-deps

  // Drive the WS-reconnect elapsed timer and countdown to next attempt.
  useEffect(() => {
    if (state !== "reconnecting") {
      if (reconnectTimerRef.current) {
        clearInterval(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      reconnectStartRef.current = null;
      setReconnectElapsedSec(0);
      setReconnectCountdownSec(0);
      return;
    }
    reconnectStartRef.current = Date.now();
    setReconnectElapsedSec(0);
    reconnectTimerRef.current = setInterval(() => {
      const now = Date.now();
      if (reconnectStartRef.current !== null) {
        setReconnectElapsedSec(Math.floor((now - reconnectStartRef.current) / 1000));
      }
      setReconnectCountdownSec(Math.max(0, Math.ceil((reconnectRetryAtRef.current - now) / 1000)));
    }, 1000);
    return () => {
      if (reconnectTimerRef.current) {
        clearInterval(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };
  }, [state]); // eslint-disable-line react-hooks/exhaustive-deps

  // Manual "Tap to retry" — close the dead PC and ask for a fresh offer.
  const handleManualRetry = () => {
    if (iceWatchdogRef.current) {
      clearTimeout(iceWatchdogRef.current);
      iceWatchdogRef.current = null;
    }
    pcRef.current?.close();
    pcRef.current = null;
    iceRetryCountRef.current += 1;
    setIceRetryCount(iceRetryCountRef.current);
    startConnectingTimer(false /* preserve cumulative */);
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "request-offer", code }));
      // Same 30-s offer watchdog as the ICE watchdog path — if no offer
      // arrives the broadcaster is offline; fall back gracefully.
      if (offerWatchdogRef.current) clearTimeout(offerWatchdogRef.current);
      offerWatchdogRef.current = setTimeout(() => {
        offerWatchdogRef.current = null;
        setState((prev) => (prev === "connecting" ? "waiting-for-broadcaster" : prev));
      }, 30_000);
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
        // ICE succeeded — cancel the hang watchdog.
        if (iceWatchdogRef.current) {
          clearTimeout(iceWatchdogRef.current);
          iceWatchdogRef.current = null;
        }
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
        // Proactive offer watchdog: if no offer arrives within 30 s of joining
        // (broadcaster is mid-reconnect), send request-offer once, then wait
        // another 30 s; if still no offer the broadcaster is truly offline and
        // we fall back to "waiting-for-broadcaster" instead of looping forever.
        if (offerWatchdogRef.current) clearTimeout(offerWatchdogRef.current);
        offerWatchdogRef.current = setTimeout(() => {
          offerWatchdogRef.current = null;
          if (ws.readyState !== WebSocket.OPEN) return;
          iceRetryCountRef.current += 1;
          setIceRetryCount(iceRetryCountRef.current);
          startConnectingTimer(false /* preserve cumulative */);
          ws.send(JSON.stringify({ type: "request-offer", code }));
          // Second stage: if the broadcaster still doesn't respond in 30 s,
          // they are offline — show "waiting-for-broadcaster" gracefully.
          offerWatchdogRef.current = setTimeout(() => {
            offerWatchdogRef.current = null;
            setState((prev) =>
              prev === "connecting" || prev === "reconnecting"
                ? "waiting-for-broadcaster"
                : prev
            );
          }, 30_000);
        }, 30_000);
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
          // An offer arrived — the broadcaster is present. Cancel the
          // offer-response watchdog so we don't fall back to
          // "waiting-for-broadcaster" mid-negotiation.
          if (offerWatchdogRef.current) {
            clearTimeout(offerWatchdogRef.current);
            offerWatchdogRef.current = null;
          }
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

          // ICE hang watchdog: some browsers (especially on restrictive gym
          // networks) stay in "checking" indefinitely without ever firing
          // "failed", leaving the viewer stuck on "Joining the stream…"
          // forever. After 20 s without reaching "connected", close the dead
          // PC and ask the broadcaster for a fresh offer on the same viewer
          // slot — avoids burning a WS reconnect attempt.
          if (iceWatchdogRef.current) clearTimeout(iceWatchdogRef.current);
          iceWatchdogRef.current = setTimeout(() => {
            iceWatchdogRef.current = null;
            if (pc.connectionState === "connected" || pc.connectionState === "closed") return;
            pc.close();
            // Let the viewer know a retry is happening and reset the per-attempt timer.
            // Cumulative timer (connectingTotal) keeps running — that gates the retry button.
            iceRetryCountRef.current += 1;
            setIceRetryCount(iceRetryCountRef.current);
            startConnectingTimer(false /* preserve cumulative */);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "request-offer", code }));
              // Start a 30-s window expecting an offer back. If none arrives the
              // broadcaster is likely offline — fall back to waiting-for-broadcaster
              // rather than looping retries indefinitely.
              if (offerWatchdogRef.current) clearTimeout(offerWatchdogRef.current);
              offerWatchdogRef.current = setTimeout(() => {
                offerWatchdogRef.current = null;
                setState((prev) =>
                  prev === "connecting" || prev === "reconnecting"
                    ? "waiting-for-broadcaster"
                    : prev
                );
              }, 30_000);
            }
          }, 20_000);
        } else if (message.type === "ice-candidate") {
          if (pcRef.current && message.candidate) {
            await pcRef.current.addIceCandidate(new RTCIceCandidate(message.candidate));
          }
        } else if (message.type === "broadcaster-left") {
          // Broadcaster's WebSocket dropped (network hiccup, server
          // restart, etc.) — their recording app keeps running and will
          // reconnect. Drop the dead RTCPeerConnection but stay on this
          // page in "waiting-for-broadcaster" state so the stream resumes
          // automatically when they come back, without the viewer having
          // to reload or re-enter a code.
          // The server will push a new offer when the broadcaster rejoins,
          // so the proactive offer watchdog is no longer needed.
          if (offerWatchdogRef.current) {
            clearTimeout(offerWatchdogRef.current);
            offerWatchdogRef.current = null;
          }
          pcRef.current?.close();
          pcRef.current = null;
          setState("waiting-for-broadcaster");
        } else if (message.type === "stream-ended") {
          // Coach deliberately tapped "Stop Stream" — show the final
          // score summary and stop trying to reconnect.
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
        } else if (message.type === "turn-status") {
          // Broadcaster's TURN health-check result — show or clear the
          // self-diagnostic banner so viewers on restrictive networks get
          // actionable guidance instead of a silent freeze.
          setTurnRelayDown(!message.turnAvailable);
          // Clear any prior dismissal when the relay recovers so the banner
          // can surface again if the relay goes down a second time.
          if (message.turnAvailable) setTurnBannerDismissed(false);
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
        setReconnectAttemptCount(reconnectAttemptsRef.current + 1);
        const delay = WATCH_RECONNECT_DELAYS_MS[reconnectAttemptsRef.current] ?? 8000;
        reconnectRetryAtRef.current = Date.now() + delay;
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
      if (iceWatchdogRef.current) clearTimeout(iceWatchdogRef.current);
      if (offerWatchdogRef.current) clearTimeout(offerWatchdogRef.current);
      if (reconnectTimerRef.current) clearInterval(reconnectTimerRef.current);
      stopConnectingTimer();
      pcRef.current?.close();
      wsRef.current?.close();
    };
  }, [code]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (state === "live") attachStream();
  }, [state]);

  return (
    <div
      ref={containerRef}
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

      {state === "live" && turnRelayDown && !turnBannerDismissed && (
        <div
          className="absolute inset-x-3 z-20 flex items-start justify-between gap-3 rounded-lg bg-amber-500/90 px-3 py-2.5 text-amber-950 backdrop-blur-sm shadow-lg"
          style={{ top: "calc(env(safe-area-inset-top) + 0.75rem)" }}
        >
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span className="flex-1 text-xs font-semibold leading-snug">
            Your network may be blocking this stream — try switching to mobile data if the video freezes.
          </span>
          <button
            type="button"
            onClick={() => setTurnBannerDismissed(true)}
            className="shrink-0 rounded-full p-0.5 hover:bg-amber-700/20 transition-colors"
            aria-label="Dismiss warning"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

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

      {state === "live" && scoreboard && (() => {
        // Decide which black bar to anchor the scoreboard in.
        // Priority: top bar (most legible) → left bar → minimal safe-area strip.
        // The container div is sized to exactly the available black space so
        // items-center vertically centers the pill within it.
        const MIN_BAR = 32; // px — minimum bar size worth using
        const useTopBar = letterboxTop >= MIN_BAR;
        const useLeftBar = !useTopBar && letterboxLeft >= 80;

        if (useLeftBar) {
          // Portrait video on landscape device: side bars only.
          // Stack score vertically in the left black bar.
          return (
            <div
              className="absolute top-0 bottom-0 left-0 flex flex-col items-center justify-center gap-1 pointer-events-none py-4"
              style={{ width: `${Math.round(letterboxLeft)}px` }}
            >
              <span className="font-display font-bold text-2xl tabular-nums text-primary leading-none drop-shadow-[0_0_8px_hsl(var(--primary)/0.7)]">
                {scoreboard.teamScore}
              </span>
              <span className="text-white/40 text-xs font-bold leading-none">vs</span>
              <span className="font-display font-bold text-2xl tabular-nums text-white leading-none">
                {scoreboard.opponentScore}
              </span>
              <span className="mt-1 flex items-center gap-0.5 rounded-full bg-red-600/90 px-1.5 py-0.5 text-[9px] font-bold text-white">
                <Radio className="w-2.5 h-2.5" /> LIVE
              </span>
            </div>
          );
        }

        // Top bar (or minimal strip when no bar at all).
        const barHeight = useTopBar
          ? Math.round(letterboxTop)
          : 0; // 0 → wrapper uses safe-area padding only
        return (
          <div
            className="absolute top-0 left-0 right-0 flex justify-center items-center pointer-events-none"
            style={useTopBar
              ? { height: `${barHeight}px` }
              : { paddingTop: "env(safe-area-inset-top)", paddingBottom: "0.5rem" }}
          >
            {/* Compact score pill — deliberately smaller than the old design
                so it never crowds the actual video content. */}
            <div className="flex items-center gap-2 rounded-xl border border-white/15 bg-black/85 px-3 py-1.5 backdrop-blur-md shadow-[0_4px_20px_rgba(0,0,0,0.65)]">
              <span className="font-display font-bold uppercase tracking-wide text-white/90 text-xs truncate max-w-[22vw] text-right leading-none">
                {(status?.teamName ?? "Team").slice(0, 12)}
              </span>
              <span className="font-display font-bold text-xl tabular-nums shrink-0 text-primary leading-none drop-shadow-[0_0_8px_hsl(var(--primary)/0.6)]">
                {scoreboard.teamScore}<span className="mx-1 text-white/35 text-base">-</span>{scoreboard.opponentScore}
              </span>
              <span className="font-display font-bold uppercase tracking-wide text-white/90 text-xs truncate max-w-[22vw] text-left leading-none">
                {(status?.opponent ?? "Opp").slice(0, 12)}
              </span>
              <span className="flex items-center gap-0.5 rounded-full bg-red-600/90 px-1.5 py-0.5 text-[9px] font-bold text-white shrink-0 ml-0.5">
                <Radio className="w-2.5 h-2.5" /> LIVE
              </span>
            </div>
          </div>
        );
      })()}

      {state === "live" && statEvents.length > 0 && (() => {
        // Mirror the scoreboard logic: put stat pills in whichever black bar
        // is available so they never land on top of court action.
        const MIN_LEFT_BAR = 80;
        const inLeftBar = letterboxLeft >= MIN_LEFT_BAR;
        const inTopBar = !inLeftBar && letterboxTop >= 32;

        const style: React.CSSProperties = inLeftBar
          ? {
              // Stack inside the left side bar, below any overlapping controls
              left: 4,
              top: "50%",
              transform: "translateY(-50%)",
              width: Math.round(letterboxLeft) - 8,
              maxWidth: Math.round(letterboxLeft) - 8,
            }
          : inTopBar
          ? {
              // Below the scoreboard in the top bar
              left: 8,
              top: Math.round(letterboxTop) + 4,
              maxWidth: "90%",
            }
          : {
              // No good black space — float just inside the top of the video
              left: 8,
              top: 64,
              maxWidth: "75%",
            };

        return (
          <div className="absolute flex flex-col gap-1 pointer-events-none" style={style}>
            {statEvents.slice(-4).map((ev) => (
              <div
                key={ev.id}
                className="flex items-center gap-1 rounded-full bg-black/70 backdrop-blur-sm px-2.5 py-1 text-white text-[11px] font-semibold shadow-md animate-in fade-in slide-in-from-left-2"
              >
                <span className="text-primary font-bold">{ev.label}</span>
                <span className="truncate">{ev.playerName}</span>
              </div>
            ))}
          </div>
        );
      })()}

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

      {/* Branding watermark — always visible in corner */}
      <a
        href="https://stecstats.com"
        target="_blank"
        rel="noopener noreferrer"
        className="absolute top-3 right-3 z-20 pointer-events-auto"
        style={{ paddingTop: "env(safe-area-inset-top)" }}
      >
        <img
          src="/logo.png"
          alt="StecStats"
          className="h-7 w-auto object-contain opacity-60 hover:opacity-90 transition-opacity drop-shadow-[0_1px_4px_rgba(0,0,0,0.8)]"
        />
      </a>

      {state !== "live" && (
        <div className="absolute inset-0 text-center text-white/80 flex flex-col items-center justify-center gap-3 p-6">
          <h1 className="text-xl font-display font-bold uppercase tracking-tight mb-2">
            {status ? `${status.teamName} vs ${status.opponent}` : "Live Game"}
          </h1>
          {state === "connecting" && (
            <>
              <Loader2 className="w-8 h-8 animate-spin" />
              {iceRetryCount === 0 ? (
                <p>Joining the stream…</p>
              ) : (
                <p className="text-primary font-semibold">
                  Retrying… (attempt {iceRetryCount + 1})
                </p>
              )}
              {connectingElapsed >= ELAPSED_THRESHOLD_S && (
                <p className="text-sm text-white/50 tabular-nums">
                  Still connecting… {formatElapsed(connectingElapsed)}
                </p>
              )}
              {connectingTotal >= RETRY_THRESHOLD_S && (
                <button
                  onClick={handleManualRetry}
                  className="mt-1 flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-5 py-2 text-sm font-semibold text-white hover:bg-white/20 transition-colors"
                >
                  <RefreshCw className="w-4 h-4" />
                  Tap to retry
                </button>
              )}
            </>
          )}
          {state === "waiting-for-broadcaster" && (
            <>
              <Users className="w-8 h-8 text-primary" />
              <p className="max-w-sm text-white">{explicitEndRef.current ? "Game hasn't started yet. You're in the right place — it'll connect automatically when the coach goes live." : "Stream interrupted — staying connected. It'll resume automatically when the coach reconnects."}</p>
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
              <p className="max-w-sm font-semibold">Reconnecting…</p>
              <p className="text-sm text-white/60">
                {reconnectAttemptCount > 0
                  ? `Attempt ${reconnectAttemptCount} of ${MAX_WATCH_RECONNECT_ATTEMPTS}`
                  : "Waiting for the stream to resume"}
                {reconnectElapsedSec > 0 && ` · ${reconnectElapsedSec}s elapsed`}
              </p>
              {reconnectCountdownSec > 0 && (
                <p className="text-sm font-semibold text-primary/80 tabular-nums">
                  next attempt in {reconnectCountdownSec}s
                </p>
              )}
              <p className="text-xs text-white/40 max-w-xs text-center">Stay on this page — the stream will resume automatically.</p>
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
