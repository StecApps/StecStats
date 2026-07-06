import { useState, useEffect, useRef } from "react";
import { 
  useListPlayers, 
  useListTeams,
  useCreateGame,
  useUpdateGame,
  useGetGame,
  useCreateTeam,
  useCreatePlayer,
  useGetGameHighlight,
  useGenerateGameHighlight,
  getGetGameHighlightQueryKey,
  getGetGameQueryKey,
  getGetPlayerSummaryQueryKey,
  getListPlayerTeamGroupsQueryKey,
  getListTeamGamesQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useParams, useSearch } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Plus, ArrowLeft, Minus, UserPlus, Check, X, CalendarDays, Video, Circle, Square, Play, Radio, Copy, Users, SwitchCamera, ZoomIn, ZoomOut, Aperture, Mic, MicOff, Sparkles, Download, Share2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { getIceServers, liveWsUrl, startLiveSession, stopLiveSession, watchUrlForCode } from "@/lib/liveStream";

type StatCounters = {
  playerId: number;
  ftMade: number;
  ftAttempted: number;
  twoMade: number;
  twoAttempted: number;
  threeMade: number;
  threeAttempted: number;
  assists: number;
  rebounds: number;
  steals: number;
  turnovers: number;
  blocks: number;
};

type GameEventEntry = {
  playerId: number;
  statField: string;
  delta: number;
  videoTimestampMs: number;
};

const initialStats = (playerId: number): StatCounters => ({
  playerId, ftMade: 0, ftAttempted: 0, twoMade: 0, twoAttempted: 0, threeMade: 0, threeAttempted: 0, assists: 0, rebounds: 0, steals: 0, turnovers: 0, blocks: 0
});

const STAT_LABELS: Record<string, string> = {
  ftMade: "FT Made", ftAttempted: "FT Miss", twoMade: "2PT Made", twoAttempted: "2PT Miss",
  threeMade: "3PT Made", threeAttempted: "3PT Miss", assists: "Assist", rebounds: "Rebound",
  steals: "Steal", turnovers: "Turnover", blocks: "Block",
};

function formatMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

async function uploadVideoBlob(blob: Blob): Promise<string> {
  const requestRes = await fetch("/api/storage/uploads/request-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: `game-recording-${Date.now()}.webm`,
      size: blob.size,
      contentType: blob.type || "video/webm",
    }),
  });
  if (!requestRes.ok) throw new Error("Failed to request upload URL");
  const { uploadURL, objectPath } = await requestRes.json();

  const putRes = await fetch(uploadURL, {
    method: "PUT",
    headers: { "Content-Type": blob.type || "video/webm" },
    body: blob,
  });
  if (!putRes.ok) throw new Error("Failed to upload video");

  return objectPath as string;
}

function videoObjectSrc(objectPath: string): string {
  return `/api/storage/objects/${objectPath.replace(/^\/objects\//, "")}`;
}

export default function RecordGame() {
  const params = useParams();
  const search = useSearch();
  const gameId = params.id ? parseInt(params.id, 10) : undefined;
  const isEditing = !!gameId;
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const preselectedTeamId = new URLSearchParams(search).get("teamId") || "";

  const { data: gameToEdit, isLoading: gameLoading } = useGetGame(gameId as number, {
    query: { enabled: isEditing, queryKey: getGetGameQueryKey(gameId as number) }
  });

  const { data: players } = useListPlayers();
  const { data: teams, refetch: refetchTeams } = useListTeams();
  const createTeam = useCreateTeam();
  const createPlayer = useCreatePlayer();
  const createGame = useCreateGame();
  const updateGame = useUpdateGame();
  const generateHighlight = useGenerateGameHighlight();

  const { data: highlight } = useGetGameHighlight(gameId as number, {
    query: {
      enabled: isEditing,
      queryKey: getGetGameHighlightQueryKey(gameId as number),
      refetchInterval: (query) =>
        query.state.data?.status === "processing" ? 3000 : false,
    },
  });

  const highlightFileName = () => {
    const opp = (opponent || "game").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
    return `stec-highlights-${opp || "game"}.mp4`;
  };

  const handleGenerateHighlight = async () => {
    if (!gameId) return;
    try {
      await generateHighlight.mutateAsync({ gameId });
      await queryClient.invalidateQueries({ queryKey: getGetGameHighlightQueryKey(gameId) });
    } catch {
      toast({ title: "Couldn't start the highlight reel", variant: "destructive" });
    }
  };

  const handleDownloadHighlight = () => {
    if (!highlight?.highlightObjectPath) return;
    const a = document.createElement("a");
    a.href = videoObjectSrc(highlight.highlightObjectPath);
    a.download = highlightFileName();
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const handleShareHighlight = async () => {
    if (!highlight?.highlightObjectPath) return;
    try {
      const res = await fetch(videoObjectSrc(highlight.highlightObjectPath));
      const blob = await res.blob();
      const file = new File([blob], highlightFileName(), { type: "video/mp4" });
      const nav = navigator as Navigator & { canShare?: (data?: ShareData) => boolean };
      if (nav.canShare && nav.canShare({ files: [file] })) {
        await nav.share({ files: [file], title: "Game Highlights" });
      } else {
        handleDownloadHighlight();
      }
    } catch {
      toast({ title: "Couldn't share the highlight reel", variant: "destructive" });
    }
  };

  const [teamId, setTeamId] = useState<string>(preselectedTeamId);
  const [opponent, setOpponent] = useState("");
  const [date, setDate] = useState<Date>(new Date());
  const [teamScore, setTeamScore] = useState<number>(0);
  const [opponentScore, setOpponentScore] = useState<number>(0);
  
  const [selectedPlayerIds, setSelectedPlayerIds] = useState<number[]>([]);
  const [stats, setStats] = useState<Record<number, StatCounters>>({});

  const [newTeamName, setNewTeamName] = useState("");
  const [isAddTeamOpen, setIsAddTeamOpen] = useState(false);

  const [newPlayerName, setNewPlayerName] = useState("");
  const [isAddPlayerOpen, setIsAddPlayerOpen] = useState(false);

  const [existingVideoObjectPath, setExistingVideoObjectPath] = useState<string | null>(null);
  const [events, setEvents] = useState<GameEventEntry[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [recordedPreviewUrl, setRecordedPreviewUrl] = useState<string | null>(null);
  const [isUploadingVideo, setIsUploadingVideo] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);

  const [isLive, setIsLive] = useState(false);
  const [liveCode, setLiveCode] = useState<string | null>(null);
  const [viewerCount, setViewerCount] = useState(0);
  const [isStartingLive, setIsStartingLive] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [facingMode, setFacingMode] = useState<"environment" | "user">("environment");
  const [zoom, setZoom] = useState(1);
  const [canSwitchCamera, setCanSwitchCamera] = useState(false);
  const [micMuted, setMicMuted] = useState(false);
  const [focusPlayerId, setFocusPlayerId] = useState<number | null>(null);
  const [isReconnectingLive, setIsReconnectingLive] = useState(false);
  const [liveInterrupted, setLiveInterrupted] = useState(false);

  const livePreviewRef = useRef<HTMLVideoElement | null>(null);
  const playbackRef = useRef<HTMLVideoElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordingStartRef = useRef<number>(0);
  const liveWsRef = useRef<WebSocket | null>(null);
  const livePeersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const liveCodeRef = useRef<string | null>(null);
  const rawStreamRef = useRef<MediaStream | null>(null);
  const sourceVideoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const zoomRef = useRef(1);
  const usesCanvasRef = useRef(false);
  const environmentLensesRef = useRef<{ id: string; label: string }[]>([]);
  const currentDeviceIdRef = useRef<string | null>(null);
  const [canCycleLens, setCanCycleLens] = useState(false);
  const [lensLabel, setLensLabel] = useState("");
  const previewContainerRef = useRef<HTMLDivElement | null>(null);
  const pinchStartDistRef = useRef<number | null>(null);
  const pinchStartZoomRef = useRef(1);
  const MAX_ZOOM = 5;
  const IDEAL_VIDEO_CONSTRAINTS = { width: { ideal: 2560 }, height: { ideal: 1440 }, frameRate: { ideal: 30 } };

  const lensLabelFromDeviceLabel = (label: string): string => {
    if (/ultra.?wide|0\.5/i.test(label)) return "0.5×";
    if (/telephoto|tele/i.test(label)) return "Tele";
    if (/wide|back|rear/i.test(label)) return "1×";
    return "";
  };

  const syncLensLabel = (deviceId: string | null) => {
    const lens = environmentLensesRef.current.find(l => l.id === deviceId);
    setLensLabel(lens?.label ?? "");
  };

  const stopMediaPipeline = () => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const src = sourceVideoRef.current;
    const srcStream = src?.srcObject as MediaStream | null;
    srcStream?.getTracks().forEach(t => t.stop());
    if (src) src.srcObject = null;
    streamRef.current?.getTracks().forEach(t => t.stop());
    rawStreamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    rawStreamRef.current = null;
    sourceVideoRef.current = null;
    canvasRef.current = null;
    usesCanvasRef.current = false;
    environmentLensesRef.current = [];
    currentDeviceIdRef.current = null;
    setCanCycleLens(false);
    setLensLabel("");
  };

  const refreshEnvironmentLensOptions = async (currentDeviceId: string | null): Promise<string | null> => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoInputs = devices.filter(d => d.kind === "videoinput");
      const backCandidates = videoInputs.filter(d => !/front|user|face|selfie/i.test(d.label));
      environmentLensesRef.current = backCandidates.map(d => ({ id: d.deviceId, label: lensLabelFromDeviceLabel(d.label) }));
      setCanCycleLens(backCandidates.length > 1);
      const wideMatch = backCandidates.find(d => /ultra.?wide|wide.?angle|0\.5x/i.test(d.label));
      return wideMatch && wideMatch.deviceId !== currentDeviceId ? wideMatch.deviceId : null;
    } catch {
      environmentLensesRef.current = [];
      setCanCycleLens(false);
      return null;
    }
  };
  const liveManualStopRef = useRef(false);
  const liveReconnectAttemptsRef = useRef(0);
  const liveReconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (isEditing && gameToEdit) {
      setTeamId(gameToEdit.teamId.toString());
      setOpponent(gameToEdit.opponent);
      setDate(new Date(gameToEdit.date));
      setTeamScore(gameToEdit.teamScore);
      setOpponentScore(gameToEdit.opponentScore);
      
      const ids = gameToEdit.stats.map(s => s.playerId);
      setSelectedPlayerIds(ids);
      
      const statsObj: Record<number, StatCounters> = {};
      gameToEdit.stats.forEach(s => {
        statsObj[s.playerId] = {
          playerId: s.playerId,
          ftMade: s.ftMade, ftAttempted: s.ftAttempted,
          twoMade: s.twoMade, twoAttempted: s.twoAttempted,
          threeMade: s.threeMade, threeAttempted: s.threeAttempted,
          assists: s.assists, rebounds: s.rebounds,
          steals: s.steals, turnovers: s.turnovers, blocks: s.blocks
        };
      });
      setStats(statsObj);
      setExistingVideoObjectPath(gameToEdit.videoObjectPath ?? null);
      setEvents(gameToEdit.events ?? []);
    }
  }, [isEditing, gameToEdit]);

  useEffect(() => {
    return () => {
      stopMediaPipeline();
      if (recordedPreviewUrl) URL.revokeObjectURL(recordedPreviewUrl);
      liveManualStopRef.current = true;
      if (liveReconnectTimeoutRef.current) clearTimeout(liveReconnectTimeoutRef.current);
      livePeersRef.current.forEach(pc => pc.close());
      liveWsRef.current?.close();
      if (liveCodeRef.current) stopLiveSession(liveCodeRef.current);
    };
  }, [recordedPreviewUrl]);

  useEffect(() => {
    if (!isRecording) return;
    const interval = setInterval(() => {
      setElapsedMs(Date.now() - recordingStartRef.current);
    }, 500);
    return () => clearInterval(interval);
  }, [isRecording]);

  useEffect(() => {
    if (isRecording && livePreviewRef.current && streamRef.current) {
      if (livePreviewRef.current.srcObject !== streamRef.current) {
        livePreviewRef.current.srcObject = streamRef.current;
      }
      livePreviewRef.current.play().catch(() => {});
    }
  }, [isRecording]);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  useEffect(() => {
    if (isLive && liveCodeRef.current && liveWsRef.current?.readyState === WebSocket.OPEN) {
      liveWsRef.current.send(JSON.stringify({
        type: "scoreboard",
        code: liveCodeRef.current,
        teamScore,
        opponentScore,
      }));
    }
  }, [teamScore, opponentScore, isLive]);

  useEffect(() => {
    if (focusPlayerId !== null && selectedPlayerIds.includes(focusPlayerId)) return;
    setFocusPlayerId(selectedPlayerIds[0] ?? null);
  }, [selectedPlayerIds, focusPlayerId]);

  useEffect(() => {
    if (!isRecording) return;
    const el = previewContainerRef.current;
    if (!el) return;

    const pinchDistance = (touches: TouchList) => {
      const [a, b] = [touches[0], touches[1]];
      return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    };

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        pinchStartDistRef.current = pinchDistance(e.touches);
        pinchStartZoomRef.current = zoomRef.current;
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 2 && pinchStartDistRef.current) {
        e.preventDefault();
        const dist = pinchDistance(e.touches);
        const scale = dist / pinchStartDistRef.current;
        const nextZoom = Math.min(MAX_ZOOM, Math.max(1, Math.round(pinchStartZoomRef.current * scale * 10) / 10));
        setZoom(nextZoom);
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) {
        pinchStartDistRef.current = null;
      }
    };

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    el.addEventListener("touchcancel", onTouchEnd, { passive: true });

    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [isRecording]);

  const startDrawLoop = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    const draw = () => {
      const v = sourceVideoRef.current;
      const c = canvasRef.current;
      if (v && c && v.videoWidth > 0 && v.videoHeight > 0) {
        const ctx = c.getContext("2d");
        if (ctx) {
          const vw = v.videoWidth;
          const vh = v.videoHeight;
          if (c.width !== vw || c.height !== vh) {
            c.width = vw;
            c.height = vh;
          }
          const z = Math.max(1, zoomRef.current);
          const sw = vw / z;
          const sh = vh / z;
          const sx = (vw - sw) / 2;
          const sy = (vh - sh) / 2;
          ctx.drawImage(v, sx, sy, sw, sh, 0, 0, vw, vh);
        }
      }
      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
  };

  const switchCamera = async () => {
    if (!usesCanvasRef.current || !sourceVideoRef.current) return;
    const next = facingMode === "environment" ? "user" : "environment";
    try {
      let newStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: next, ...IDEAL_VIDEO_CONSTRAINTS },
        audio: false,
      });
      let newDeviceId = newStream.getVideoTracks()[0]?.getSettings().deviceId ?? null;

      if (next === "environment") {
        const wideId = await refreshEnvironmentLensOptions(newDeviceId);
        if (wideId) {
          try {
            const wideStream = await navigator.mediaDevices.getUserMedia({
              video: { deviceId: { exact: wideId }, ...IDEAL_VIDEO_CONSTRAINTS },
              audio: false,
            });
            newStream.getVideoTracks().forEach(t => t.stop());
            newStream = wideStream;
            newDeviceId = wideId;
          } catch {
            // Wide lens open failed; keep the default back camera stream.
          }
        }
        syncLensLabel(newDeviceId);
      } else {
        environmentLensesRef.current = [];
        setCanCycleLens(false);
        setLensLabel("");
      }

      const src = sourceVideoRef.current;
      const prev = src.srcObject as MediaStream | null;
      prev?.getVideoTracks().forEach(t => t.stop());
      src.srcObject = newStream;
      await src.play().catch(() => {});
      currentDeviceIdRef.current = newDeviceId;
      setFacingMode(next);
      setZoom(1);
    } catch {
      setCameraError("Could not switch camera on this device.");
    }
  };

  const cycleLens = async () => {
    if (!usesCanvasRef.current || !sourceVideoRef.current) return;
    const lenses = environmentLensesRef.current;
    if (lenses.length < 2) return;
    const idx = lenses.findIndex(l => l.id === (currentDeviceIdRef.current || ""));
    const nextLens = lenses[(idx + 1 + lenses.length) % lenses.length];
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: nextLens.id }, ...IDEAL_VIDEO_CONSTRAINTS },
        audio: false,
      });
      const src = sourceVideoRef.current;
      const prev = src.srcObject as MediaStream | null;
      prev?.getVideoTracks().forEach(t => t.stop());
      src.srcObject = newStream;
      await src.play().catch(() => {});
      currentDeviceIdRef.current = nextLens.id;
      syncLensLabel(nextLens.id);
      setZoom(1);
    } catch {
      setCameraError("Could not switch lens on this device.");
    }
  };

  const adjustZoom = (delta: number) => {
    setZoom(z => Math.min(MAX_ZOOM, Math.max(1, Math.round((z + delta) * 10) / 10)));
  };

  const toggleMic = () => {
    const next = !micMuted;
    rawStreamRef.current?.getAudioTracks().forEach(t => { t.enabled = !next; });
    setMicMuted(next);
  };

  const startRecording = async () => {
    setCameraError(null);
    try {
      let rawStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode, ...IDEAL_VIDEO_CONSTRAINTS },
        audio: true,
      });
      currentDeviceIdRef.current = rawStream.getVideoTracks()[0]?.getSettings().deviceId ?? null;

      if (facingMode === "environment") {
        const wideId = await refreshEnvironmentLensOptions(currentDeviceIdRef.current);
        if (wideId) {
          try {
            const wideStream = await navigator.mediaDevices.getUserMedia({
              video: { deviceId: { exact: wideId }, ...IDEAL_VIDEO_CONSTRAINTS },
              audio: false,
            });
            const wideTrack = wideStream.getVideoTracks()[0];
            if (wideTrack) {
              rawStream.getVideoTracks().forEach(t => t.stop());
              rawStream = new MediaStream([wideTrack, ...rawStream.getAudioTracks()]);
              currentDeviceIdRef.current = wideId;
            }
          } catch {
            // Wide lens open failed; keep the default back camera stream.
          }
        }
        syncLensLabel(currentDeviceIdRef.current);
      } else {
        environmentLensesRef.current = [];
        setCanCycleLens(false);
        setLensLabel("");
      }

      rawStreamRef.current = rawStream;

      let recordStream: MediaStream;
      const canvasSupported = typeof HTMLCanvasElement !== "undefined" &&
        typeof HTMLCanvasElement.prototype.captureStream === "function";

      if (canvasSupported) {
        const sourceVideo = document.createElement("video");
        sourceVideo.muted = true;
        sourceVideo.playsInline = true;
        sourceVideo.autoplay = true;
        sourceVideo.srcObject = rawStream;
        sourceVideoRef.current = sourceVideo;
        await sourceVideo.play().catch(() => {});
        await new Promise<void>(resolve => {
          if (sourceVideo.videoWidth > 0) return resolve();
          sourceVideo.onloadedmetadata = () => resolve();
          setTimeout(() => resolve(), 1500);
        });

        const canvas = document.createElement("canvas");
        canvas.width = sourceVideo.videoWidth || 1280;
        canvas.height = sourceVideo.videoHeight || 720;
        canvasRef.current = canvas;
        setZoom(1);
        zoomRef.current = 1;
        startDrawLoop();

        const canvasStream = canvas.captureStream(30);
        canvasStream.getVideoTracks().forEach(t => { t.contentHint = "motion"; });
        const output = new MediaStream();
        canvasStream.getVideoTracks().forEach(t => output.addTrack(t));
        rawStream.getAudioTracks().forEach(t => output.addTrack(t));
        recordStream = output;
        usesCanvasRef.current = true;
        setCanSwitchCamera(true);
      } else {
        recordStream = rawStream;
        usesCanvasRef.current = false;
        setCanSwitchCamera(false);
      }

      streamRef.current = recordStream;

      chunksRef.current = [];
      const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
        ? "video/webm;codecs=vp9,opus"
        : "video/webm";
      const recorder = new MediaRecorder(recordStream, {
        mimeType,
        videoBitsPerSecond: 10_000_000,
        audioBitsPerSecond: 128_000,
      });
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mimeType });
        setRecordedBlob(blob);
        setRecordedPreviewUrl(URL.createObjectURL(blob));
        stopMediaPipeline();
      };

      mediaRecorderRef.current = recorder;
      recordingStartRef.current = Date.now();
      recorder.start();
      setIsRecording(true);
      setMicMuted(false);
      setRecordedBlob(null);
      setEvents([]);
      setElapsedMs(0);
      if (recordedPreviewUrl) {
        URL.revokeObjectURL(recordedPreviewUrl);
        setRecordedPreviewUrl(null);
      }
    } catch (err) {
      stopMediaPipeline();
      setCanSwitchCamera(false);
      setCameraError("Could not access camera/microphone. Check permissions and try again.");
    }
  };

  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
    setIsRecording(false);
    if (isLive) {
      stopGoingLive();
    }
  };

  const discardVideo = () => {
    if (recordedPreviewUrl) URL.revokeObjectURL(recordedPreviewUrl);
    setRecordedPreviewUrl(null);
    setRecordedBlob(null);
    setExistingVideoObjectPath(null);
    setEvents([]);
    toast({ title: "Video discarded", description: "Your stats are kept — the game will save without a video." });
  };

  const createPeerConnectionForViewer = async (viewerId: string) => {
    const iceServers = await getIceServers();
    const pc = new RTCPeerConnection({ iceServers });
    streamRef.current?.getTracks().forEach(track => {
      if (!streamRef.current) return;
      const sender = pc.addTrack(track, streamRef.current);
      if (track.kind === "video") {
        try {
          const params = sender.getParameters();
          params.encodings = params.encodings?.length ? params.encodings : [{}];
          params.encodings[0].maxBitrate = 4_000_000;
          sender.setParameters(params).catch(() => {});
        } catch {
          // Explicit bitrate hint is best-effort; the browser default still applies if unsupported.
        }
      }
    });
    pc.onicecandidate = (event) => {
      if (event.candidate && liveWsRef.current?.readyState === WebSocket.OPEN) {
        liveWsRef.current.send(JSON.stringify({
          type: "ice-candidate",
          code: liveCodeRef.current,
          targetId: viewerId,
          candidate: event.candidate,
        }));
      }
    };
    livePeersRef.current.set(viewerId, pc);
    return pc;
  };

  const MAX_LIVE_RECONNECT_ATTEMPTS = 6;
  const LIVE_RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 8000, 8000];

  const connectBroadcasterSocket = (code: string, isReconnect: boolean) => {
    const ws = new WebSocket(liveWsUrl());
    liveWsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "join-broadcaster", code }));
      setIsLive(true);
      setIsStartingLive(false);
      setIsReconnectingLive(false);
      setLiveInterrupted(false);
      if (isReconnect) {
        liveReconnectAttemptsRef.current = 0;
        toast({ title: "Live stream reconnected", description: "The broadcast has resumed." });
      }
    };

    ws.onmessage = async (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "new-viewer") {
        const pc = await createPeerConnectionForViewer(message.viewerId);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        ws.send(JSON.stringify({ type: "offer", code, targetId: message.viewerId, sdp: offer }));
        setViewerCount(livePeersRef.current.size);
      } else if (message.type === "answer") {
        const pc = livePeersRef.current.get(message.viewerId);
        if (pc) await pc.setRemoteDescription(new RTCSessionDescription(message.sdp));
      } else if (message.type === "ice-candidate") {
        const pc = livePeersRef.current.get(message.viewerId);
        if (pc && message.candidate) await pc.addIceCandidate(new RTCIceCandidate(message.candidate));
      } else if (message.type === "viewer-left") {
        const pc = livePeersRef.current.get(message.viewerId);
        pc?.close();
        livePeersRef.current.delete(message.viewerId);
        setViewerCount(livePeersRef.current.size);
      }
    };

    ws.onclose = () => {
      if (liveManualStopRef.current) return;

      // The signaling connection dropped unexpectedly (most commonly the
      // api-server restarting mid-game). The invite code was persisted
      // server-side, so we keep the camera/recording running locally and
      // try to rejoin the same session automatically instead of ending the
      // stream. Any existing peer connections are stale once the server
      // loses its in-memory viewer list, so they're torn down and rebuilt
      // as viewers rejoin.
      livePeersRef.current.forEach(pc => pc.close());
      livePeersRef.current.clear();
      setViewerCount(0);
      setIsLive(false);

      if (liveReconnectAttemptsRef.current >= MAX_LIVE_RECONNECT_ATTEMPTS) {
        setIsReconnectingLive(false);
        setLiveInterrupted(true);
        toast({
          title: "Live stream interrupted",
          description: "We couldn't reconnect the broadcast. Tap \"Go Live\" to restart it.",
          variant: "destructive",
        });
        return;
      }

      setIsReconnectingLive(true);
      const delay = LIVE_RECONNECT_DELAYS_MS[liveReconnectAttemptsRef.current] ?? 8000;
      liveReconnectAttemptsRef.current += 1;
      liveReconnectTimeoutRef.current = setTimeout(() => {
        if (liveManualStopRef.current || !liveCodeRef.current) return;
        connectBroadcasterSocket(liveCodeRef.current, true);
      }, delay);
    };
  };

  const goLive = async () => {
    if (!streamRef.current) {
      toast({ title: "Start recording first", description: "Live streaming shares the active camera feed.", variant: "destructive" });
      return;
    }
    setIsStartingLive(true);
    setLiveInterrupted(false);
    liveManualStopRef.current = false;
    liveReconnectAttemptsRef.current = 0;

    // If a previous broadcast was interrupted (e.g. the api-server
    // restarted mid-game) and gave up retrying, resume the same invite
    // code rather than minting a new one so any viewers who kept their
    // watch page open can reconnect without a new link.
    if (liveInterrupted && liveCodeRef.current) {
      connectBroadcasterSocket(liveCodeRef.current, true);
      return;
    }

    try {
      const code = await startLiveSession(opponent || "Opponent", teams?.find(t => t.id.toString() === teamId)?.name || "Team");
      liveCodeRef.current = code;
      setLiveCode(code);
      connectBroadcasterSocket(code, false);
    } catch (err) {
      setIsStartingLive(false);
      toast({ title: "Could not start live stream", variant: "destructive" });
    }
  };

  const stopGoingLive = () => {
    liveManualStopRef.current = true;
    if (liveReconnectTimeoutRef.current) {
      clearTimeout(liveReconnectTimeoutRef.current);
      liveReconnectTimeoutRef.current = null;
    }
    livePeersRef.current.forEach(pc => pc.close());
    livePeersRef.current.clear();
    liveWsRef.current?.close();
    liveWsRef.current = null;
    if (liveCodeRef.current) {
      stopLiveSession(liveCodeRef.current);
    }
    liveCodeRef.current = null;
    setIsLive(false);
    setIsReconnectingLive(false);
    setLiveInterrupted(false);
    setLiveCode(null);
    setViewerCount(0);
  };

  const copyWatchLink = () => {
    if (!liveCode) return;
    navigator.clipboard.writeText(watchUrlForCode(liveCode)).then(() => {
      toast({ title: "Link copied", description: "Share it with invited viewers." });
    }).catch(() => {});
  };

  const handleTogglePlayer = (pid: number) => {
    if (selectedPlayerIds.includes(pid)) {
      setSelectedPlayerIds(prev => prev.filter(id => id !== pid));
      setStats(prev => {
        const next = { ...prev };
        delete next[pid];
        return next;
      });
    } else {
      setSelectedPlayerIds(prev => [...prev, pid]);
      setStats(prev => ({ ...prev, [pid]: initialStats(pid) }));
    }
  };

  const updateStat = (pid: number, field: keyof StatCounters, increment: number) => {
    setStats(prev => {
      const pStats = prev[pid] || initialStats(pid);
      const nextVal = Math.max(0, pStats[field] + increment);
      
      let updates: Partial<StatCounters> = { [field]: nextVal };

      const attemptField: keyof StatCounters | null =
        field === 'twoMade' ? 'twoAttempted' :
        field === 'threeMade' ? 'threeAttempted' :
        field === 'ftMade' ? 'ftAttempted' : null;

      if (attemptField) {
        updates[attemptField] = Math.max(nextVal, pStats[attemptField] + increment);
      }
      
      return { ...prev, [pid]: { ...pStats, ...updates } };
    });

    if (isRecording) {
      const videoTimestampMs = Math.max(0, Date.now() - recordingStartRef.current);
      setEvents(prev => [...prev, { playerId: pid, statField: field, delta: increment, videoTimestampMs }]);
    }

    if (isLive && increment > 0 && liveWsRef.current?.readyState === WebSocket.OPEN) {
      const playerName = players?.find(p => p.id === pid)?.name;
      const label = STAT_LABELS[field];
      if (playerName && label) {
        liveWsRef.current.send(JSON.stringify({
          type: "stat-event",
          code: liveCodeRef.current,
          playerName,
          label,
        }));
      }
    }
  };

  const handleSave = async () => {
    if (!teamId || !opponent || !date || selectedPlayerIds.length === 0) {
      toast({ title: "Incomplete", description: "Select team, opponent, date, and at least one player.", variant: "destructive" });
      return;
    }

    if (isRecording) {
      stopRecording();
    }

    const isWin = teamScore > opponentScore;
    const isTie = teamScore === opponentScore;
    const result = isWin ? 'W' : 'L'; // Backend requires W or L

    let videoObjectPath = existingVideoObjectPath;
    if (recordedBlob) {
      setIsUploadingVideo(true);
      try {
        videoObjectPath = await uploadVideoBlob(recordedBlob);
      } catch (err) {
        setIsUploadingVideo(false);
        toast({ title: "Error uploading video", description: "The game was not saved. Try again.", variant: "destructive" });
        return;
      }
      setIsUploadingVideo(false);
    }

    const payload = {
      teamId: parseInt(teamId, 10),
      opponent,
      date: date.toISOString().split('T')[0],
      result: result as 'W' | 'L',
      teamScore,
      opponentScore,
      videoObjectPath,
      stats: Object.values(stats),
      events,
    };

    try {
      if (isEditing) {
        await updateGame.mutateAsync({ gameId: gameId as number, data: payload });
        toast({ title: "Game updated" });
      } else {
        await createGame.mutateAsync({ data: payload });
        toast({ title: "Game recorded" });
      }
      
      selectedPlayerIds.forEach(pid => {
        queryClient.invalidateQueries({ queryKey: getGetPlayerSummaryQueryKey(pid) });
        queryClient.invalidateQueries({ queryKey: getListPlayerTeamGroupsQueryKey(pid) });
      });
      queryClient.invalidateQueries({ queryKey: getListTeamGamesQueryKey(parseInt(teamId, 10)) });
      
      navigate("/dashboard");
    } catch(err) {
      toast({ title: "Error saving game", variant: "destructive" });
    }
  };

  const handleCreateTeam = async () => {
    if (!newTeamName) return;
    try {
      const t = await createTeam.mutateAsync({ data: { name: newTeamName } });
      await refetchTeams();
      setTeamId(t.id.toString());
      setIsAddTeamOpen(false);
      setNewTeamName("");
    } catch(err) {}
  };

  const handleCreatePlayer = async () => {
    if (!newPlayerName) return;
    try {
      const p = await createPlayer.mutateAsync({ data: { name: newPlayerName } });
      queryClient.invalidateQueries(); // refetch players
      handleTogglePlayer(p.id);
      setIsAddPlayerOpen(false);
      setNewPlayerName("");
    } catch(err) {}
  };

  if (isEditing && gameLoading) {
    return <div className="flex-1 flex items-center justify-center"><Loader2 className="w-8 h-8 animate-spin" /></div>;
  }

  const rosterChips = (
    <div className="flex flex-wrap gap-2">
      {players?.map(p => {
        const isSelected = selectedPlayerIds.includes(p.id);
        return (
          <Button
            key={p.id}
            variant={isSelected ? "default" : "outline"}
            className={`rounded-full ${isSelected ? 'shadow-md shadow-primary/20' : ''}`}
            onClick={() => handleTogglePlayer(p.id)}
          >
            {isSelected && <Check className="w-4 h-4 mr-2" />}
            {p.name}
          </Button>
        );
      })}
    </div>
  );

  const statTrackerCards = selectedPlayerIds.map(pid => {
    const player = players?.find(p => p.id === pid);
    const s = stats[pid] || initialStats(pid);
    const pts = (s.twoMade * 2) + (s.threeMade * 3) + s.ftMade;

    return (
      <Card key={pid} className="border-secondary/20 shadow-md overflow-hidden">
        <div className="bg-muted/60 border-b border-border/60 px-4 py-2 flex justify-between items-center">
          <h3 className="font-display font-bold text-xl uppercase tracking-wide text-foreground">{player?.name}</h3>
          <div className="font-display font-bold text-2xl text-primary">{pts} PTS</div>
        </div>
        <CardContent className="p-4 grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-4 bg-card">
          <StatCounter label="2PT" made={s.twoMade} attempt={s.twoAttempted}
            onMake={() => updateStat(pid, 'twoMade', 1)} onMiss={() => updateStat(pid, 'twoAttempted', 1)}
            onUndoMake={() => updateStat(pid, 'twoMade', -1)} onUndoMiss={() => updateStat(pid, 'twoAttempted', -1)} />
          <StatCounter label="3PT" made={s.threeMade} attempt={s.threeAttempted}
            onMake={() => updateStat(pid, 'threeMade', 1)} onMiss={() => updateStat(pid, 'threeAttempted', 1)}
            onUndoMake={() => updateStat(pid, 'threeMade', -1)} onUndoMiss={() => updateStat(pid, 'threeAttempted', -1)} />
          <StatCounter label="FT" made={s.ftMade} attempt={s.ftAttempted}
            onMake={() => updateStat(pid, 'ftMade', 1)} onMiss={() => updateStat(pid, 'ftAttempted', 1)}
            onUndoMake={() => updateStat(pid, 'ftMade', -1)} onUndoMiss={() => updateStat(pid, 'ftAttempted', -1)} />

          <SingleStatCounter label="REB" value={s.rebounds} onInc={() => updateStat(pid, 'rebounds', 1)} onDec={() => updateStat(pid, 'rebounds', -1)} />
          <SingleStatCounter label="AST" value={s.assists} onInc={() => updateStat(pid, 'assists', 1)} onDec={() => updateStat(pid, 'assists', -1)} />
          <SingleStatCounter label="STL" value={s.steals} onInc={() => updateStat(pid, 'steals', 1)} onDec={() => updateStat(pid, 'steals', -1)} />
          <SingleStatCounter label="BLK" value={s.blocks} onInc={() => updateStat(pid, 'blocks', 1)} onDec={() => updateStat(pid, 'blocks', -1)} />
          <SingleStatCounter label="TO" value={s.turnovers} onInc={() => updateStat(pid, 'turnovers', 1)} onDec={() => updateStat(pid, 'turnovers', -1)} />
        </CardContent>
      </Card>
    );
  });

  const teamName = teams?.find(t => t.id.toString() === teamId)?.name || "Team";
  const focusStats = focusPlayerId !== null ? (stats[focusPlayerId] || initialStats(focusPlayerId)) : null;
  const focusPts = focusStats ? (focusStats.twoMade * 2) + (focusStats.threeMade * 3) + focusStats.ftMade : 0;

  const liveScoreboardHud = (
    <div className="sticky top-0 z-10 -mx-3 -mt-3 mb-1 border-b bg-background/95 backdrop-blur-md p-2 space-y-2">
      <div className="flex items-stretch gap-2">
        <ScoreControl label={teamName} score={teamScore} accent
          onAdd={(n: number) => setTeamScore(s => Math.max(0, s + n))} />
        <ScoreControl label={opponent || "Opponent"} score={opponentScore}
          onAdd={(n: number) => setOpponentScore(s => Math.max(0, s + n))} />
      </div>
      {selectedPlayerIds.length > 0 && focusPlayerId !== null && focusStats && (
        <div className="flex items-center gap-3">
          <Select value={focusPlayerId.toString()} onValueChange={v => setFocusPlayerId(parseInt(v, 10))}>
            <SelectTrigger className="h-8 w-[45%] shrink-0"><SelectValue /></SelectTrigger>
            <SelectContent>
              {selectedPlayerIds.map(pid => (
                <SelectItem key={pid} value={pid.toString()}>{players?.find(p => p.id === pid)?.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex flex-1 justify-around font-mono text-sm">
            <span><span className="font-bold text-primary">{focusPts}</span> <span className="text-muted-foreground text-xs">PTS</span></span>
            <span><span className="font-bold">{focusStats.rebounds}</span> <span className="text-muted-foreground text-xs">REB</span></span>
            <span><span className="font-bold">{focusStats.assists}</span> <span className="text-muted-foreground text-xs">AST</span></span>
            <span><span className="font-bold">{focusStats.steals}</span> <span className="text-muted-foreground text-xs">STL</span></span>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="flex flex-col space-y-6 pb-40 md:pb-24">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate("/dashboard")}><ArrowLeft className="w-5 h-5" /></Button>
        <h1 className="flex items-center gap-3 text-4xl font-display font-bold uppercase tracking-tight text-foreground">
          <span className="w-1.5 h-8 rounded-full bg-primary shadow-[0_0_12px_hsl(var(--primary)/0.6)]" />
          {isEditing ? "Edit Game" : "Record Game"}
        </h1>
      </div>

      <Card className="border-border/60 bg-card/40">
        <CardContent className="p-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <div className="space-y-2">
            <Label>Team / Season</Label>
            <div className="flex gap-2">
              <Select value={teamId} onValueChange={setTeamId}>
                <SelectTrigger className="flex-1"><SelectValue placeholder="Select team" /></SelectTrigger>
                <SelectContent>
                  {teams?.map(t => <SelectItem key={t.id} value={t.id.toString()}>{t.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <Dialog open={isAddTeamOpen} onOpenChange={setIsAddTeamOpen}>
                <DialogTrigger asChild><Button variant="outline" size="icon"><Plus className="w-4 h-4" /></Button></DialogTrigger>
                <DialogContent>
                  <DialogHeader><DialogTitle>New Team/Season</DialogTitle></DialogHeader>
                  <Input value={newTeamName} onChange={e => setNewTeamName(e.target.value)} placeholder="e.g. 2024 Summer League" />
                  <DialogFooter><Button onClick={handleCreateTeam}>Add</Button></DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          </div>
          
          <div className="space-y-2">
            <Label>Opponent</Label>
            <Input value={opponent} onChange={e => setOpponent(e.target.value)} placeholder="Opponent team name" />
          </div>

          <div className="space-y-2">
            <Label>Date</Label>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" className="w-full justify-start text-left font-normal">
                  <CalendarDays className="mr-2 h-4 w-4" />
                  {date ? format(date, "PPP") : <span>Pick a date</span>}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0">
                <Calendar mode="single" selected={date} onSelect={(d) => d && setDate(d)} initialFocus />
              </PopoverContent>
            </Popover>
          </div>

          <div className="space-y-2">
            <Label>Final Score (Us - Them)</Label>
            <div className="flex items-center gap-2">
              <Input type="number" value={teamScore || ''} onChange={e => setTeamScore(parseInt(e.target.value) || 0)} className="text-center font-bold font-mono text-lg text-primary bg-primary/5" />
              <span className="font-bold text-xl">-</span>
              <Input type="number" value={opponentScore || ''} onChange={e => setOpponentScore(parseInt(e.target.value) || 0)} className="text-center font-bold font-mono text-lg" />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="border-border/60 bg-card/40">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl">
            <Video className="w-5 h-5 text-primary" /> Game Video
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {cameraError && <p className="text-sm text-destructive">{cameraError}</p>}

          {isRecording && (
            <div className="flex items-center gap-2 text-sm font-semibold text-red-600">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse shrink-0" />
              Recording in progress — {formatMs(elapsedMs)}
            </div>
          )}

          {!isRecording && (recordedPreviewUrl || existingVideoObjectPath) && (
            <div className="space-y-3">
              <video
                ref={playbackRef}
                src={recordedPreviewUrl || (existingVideoObjectPath ? videoObjectSrc(existingVideoObjectPath) : undefined)}
                controls
                playsInline
                className="w-full max-w-md max-h-[70vh] rounded-lg bg-black object-contain phone-landscape:max-w-full phone-landscape:max-h-[85vh]"
              />
              {events.length > 0 && (
                <div className="space-y-1 max-w-md">
                  <Label>Stat Moments</Label>
                  <div className="max-h-48 overflow-y-auto space-y-1 border rounded-lg p-2">
                    {events.map((ev, idx) => {
                      const player = players?.find(p => p.id === ev.playerId);
                      return (
                        <button
                          key={idx}
                          type="button"
                          className="w-full flex items-center justify-between text-sm px-2 py-1 rounded hover:bg-muted text-left"
                          onClick={() => {
                            if (playbackRef.current) {
                              playbackRef.current.currentTime = ev.videoTimestampMs / 1000;
                              playbackRef.current.play().catch(() => {});
                            }
                          }}
                        >
                          <span className="flex items-center gap-2">
                            <Play className="w-3 h-3 text-primary" />
                            {player?.name ?? "Player"} — {STAT_LABELS[ev.statField] ?? ev.statField}
                          </span>
                          <span className="font-mono text-muted-foreground">{formatMs(ev.videoTimestampMs)}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" onClick={startRecording}>
                  <Circle className="w-4 h-4 mr-2 text-red-500" /> Record New Video
                </Button>
                <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={discardVideo}>
                  <X className="w-4 h-4 mr-2" /> Discard Video
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">Keep this video to save it with the game, or discard it to save your stats only.</p>
            </div>
          )}

          {!isRecording && !recordedPreviewUrl && !existingVideoObjectPath && (
            <Button variant="outline" onClick={startRecording}>
              <Circle className="w-4 h-4 mr-2 text-red-500" /> Start Recording
            </Button>
          )}

          {isUploadingVideo && (
            <p className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Uploading video...</p>
          )}

          {isEditing && existingVideoObjectPath && !recordedPreviewUrl && (
            <div className="max-w-md rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-3">
              <div className="flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-primary" />
                <span className="font-display font-bold uppercase tracking-wide text-foreground">Highlight Reel</span>
              </div>

              {highlight && highlight.eligibleMoments === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Tag some made shots, rebounds, assists, steals or blocks during the game to build a highlight reel.
                </p>
              ) : highlight?.status === "processing" ? (
                <p className="text-sm text-muted-foreground flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" /> Building your highlight reel… this can take a minute.
                </p>
              ) : highlight?.status === "ready" && highlight.highlightObjectPath ? (
                <div className="space-y-3">
                  <video
                    src={videoObjectSrc(highlight.highlightObjectPath)}
                    controls
                    playsInline
                    className="w-full rounded-lg bg-black object-contain max-h-[70vh]"
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <Button type="button" onClick={handleShareHighlight}>
                      <Share2 className="w-4 h-4 mr-2" /> Share
                    </Button>
                    <Button type="button" variant="outline" onClick={handleDownloadHighlight}>
                      <Download className="w-4 h-4 mr-2" /> Download
                    </Button>
                    <Button type="button" variant="ghost" onClick={handleGenerateHighlight} disabled={generateHighlight.isPending}>
                      {generateHighlight.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Sparkles className="w-4 h-4 mr-2" />}
                      Regenerate
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">
                    Turn this game into one shareable clip of only the best plays{highlight ? ` — ${highlight.eligibleMoments} moment${highlight.eligibleMoments === 1 ? "" : "s"} found` : ""}.
                  </p>
                  {highlight?.status === "failed" && highlight.error && (
                    <p className="text-sm text-destructive">{highlight.error}</p>
                  )}
                  <Button type="button" onClick={handleGenerateHighlight} disabled={generateHighlight.isPending}>
                    {generateHighlight.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Sparkles className="w-4 h-4 mr-2" />}
                    {highlight?.status === "failed" ? "Try Again" : "Generate Highlight Reel"}
                  </Button>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-3 text-2xl font-display font-bold uppercase text-foreground"><span className="w-1.5 h-6 rounded-full bg-primary shadow-[0_0_12px_hsl(var(--primary)/0.6)]" />Roster</h2>
          <Dialog open={isAddPlayerOpen} onOpenChange={setIsAddPlayerOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" className="h-8"><UserPlus className="w-4 h-4 mr-2"/> New Player</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>New Player</DialogTitle></DialogHeader>
              <Input value={newPlayerName} onChange={e => setNewPlayerName(e.target.value)} placeholder="Player Name" />
              <DialogFooter><Button onClick={handleCreatePlayer}>Add</Button></DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
        
        {rosterChips}
      </div>

      <div className="space-y-6">
        {statTrackerCards}
      </div>

      <div className="fixed left-0 right-0 p-4 bg-background/95 backdrop-blur-md border-t z-40 shadow-[0_-10px_40px_rgba(0,0,0,0.1)] bottom-[calc(4rem+env(safe-area-inset-bottom))] md:bottom-0">
        <div className="container max-w-screen-2xl mx-auto flex justify-between items-center">
          <div className="font-display font-bold text-2xl uppercase">
            <span className="text-primary">{teamScore}</span>
            <span className="mx-2 text-muted-foreground">-</span>
            <span>{opponentScore}</span>
          </div>
          <Button size="lg" className="font-display text-xl uppercase tracking-wider px-12 h-14" onClick={handleSave} disabled={createGame.isPending || updateGame.isPending}>
            {(createGame.isPending || updateGame.isPending) && <Loader2 className="w-5 h-5 mr-2 animate-spin" />}
            Save Game
          </Button>
        </div>
      </div>

      {isRecording && (
        <div className="fixed inset-0 z-50 flex flex-col phone-landscape:flex-row bg-black">
          <div ref={previewContainerRef} className="relative flex-[3] phone-landscape:flex-1 min-h-0 phone-landscape:min-w-0 bg-black" style={{ touchAction: "none" }}>
            <video
              ref={livePreviewRef}
              muted
              playsInline
              className="w-full h-full object-cover"
            />

            <div className="absolute top-0 left-0 right-0 flex items-start justify-between gap-2 p-3">
              <div className="flex flex-col gap-2">
                <span className="flex items-center gap-2 text-sm font-semibold text-white bg-black/50 rounded-full px-3 py-1 backdrop-blur-sm">
                  <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse shrink-0" />
                  {formatMs(elapsedMs)}
                </span>
                {isLive && liveCode && (
                  <div className="flex flex-col gap-1 rounded-lg bg-black/50 px-3 py-2 backdrop-blur-sm text-white max-w-[70vw]">
                    <span className="flex items-center gap-2 text-xs font-semibold">
                      <Radio className="w-3 h-3" /> LIVE
                      <span className="flex items-center gap-1 text-white/70"><Users className="w-3 h-3" /> {viewerCount}</span>
                    </span>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono bg-white/10 rounded px-2 py-0.5">{liveCode}</span>
                      <Button variant="ghost" size="sm" className="h-6 px-2 text-white hover:bg-white/20" onClick={copyWatchLink}>
                        <Copy className="w-3 h-3 mr-1" /> Invite
                      </Button>
                    </div>
                  </div>
                )}
              </div>

              {canSwitchCamera && (
                <div className="flex flex-col items-end gap-2">
                  <Button variant="secondary" size="sm" className="bg-black/50 text-white hover:bg-black/70 backdrop-blur-sm border-0" onClick={switchCamera}>
                    <SwitchCamera className="w-4 h-4 mr-1" />
                    {facingMode === "environment" ? "Front" : "Back"}
                  </Button>
                  {facingMode === "environment" && canCycleLens && (
                    <Button variant="secondary" size="sm" className="bg-black/50 text-white hover:bg-black/70 backdrop-blur-sm border-0" onClick={cycleLens}>
                      <Aperture className="w-4 h-4 mr-1" />
                      {lensLabel ? `Lens ${lensLabel}` : "Lens"}
                    </Button>
                  )}
                  <div className="flex items-center gap-1 rounded-md bg-black/50 px-1 backdrop-blur-sm">
                    <Button variant="ghost" size="sm" className="h-8 px-2 text-white hover:bg-white/20" onClick={() => adjustZoom(-0.5)} disabled={zoom <= 1}>
                      <ZoomOut className="w-4 h-4" />
                    </Button>
                    <span className="text-sm font-medium tabular-nums w-10 text-center text-white">{zoom.toFixed(1)}x</span>
                    <Button variant="ghost" size="sm" className="h-8 px-2 text-white hover:bg-white/20" onClick={() => adjustZoom(0.5)} disabled={zoom >= MAX_ZOOM}>
                      <ZoomIn className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              )}
            </div>

            <div className="absolute bottom-0 left-0 right-0 flex flex-wrap items-center justify-center gap-2 p-3">
              <Button variant="destructive" onClick={stopRecording}>
                <Square className="w-4 h-4 mr-2" /> Stop
              </Button>
              <Button variant="secondary" className={`bg-black/50 text-white hover:bg-black/70 backdrop-blur-sm border-0 ${micMuted ? "ring-1 ring-red-500/70" : ""}`} onClick={toggleMic}>
                {micMuted ? <MicOff className="w-4 h-4 mr-2 text-red-400" /> : <Mic className="w-4 h-4 mr-2" />}
                {micMuted ? "Muted" : "Mic"}
              </Button>
              {!isLive && !isReconnectingLive && (
                <Button variant="secondary" className="bg-black/50 text-white hover:bg-black/70 backdrop-blur-sm border-0" onClick={goLive} disabled={isStartingLive}>
                  {isStartingLive ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Radio className="w-4 h-4 mr-2 text-red-500" />}
                  Go Live
                </Button>
              )}
              {(isLive || isReconnectingLive) && (
                <Button variant="secondary" className="bg-black/50 text-white hover:bg-black/70 backdrop-blur-sm border-0" onClick={stopGoingLive}>
                  <Radio className="w-4 h-4 mr-2 text-red-500 animate-pulse" /> End Live
                </Button>
              )}
            </div>
          </div>

          <div className="flex-[2] md:flex-1 min-h-0 phone-landscape:min-w-0 phone-landscape:w-[46%] phone-landscape:flex-none overflow-y-auto bg-background p-3 space-y-4">
            {liveScoreboardHud}
            {cameraError && <p className="text-sm text-destructive">{cameraError}</p>}

            {isReconnectingLive && liveCode && (
              <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3">
                <span className="flex items-center gap-1 text-sm font-semibold text-amber-600">
                  <Loader2 className="w-4 h-4 animate-spin" /> Reconnecting live stream...
                </span>
                <span className="text-sm text-muted-foreground">
                  Your recording keeps going. The broadcast will resume automatically once reconnected.
                </span>
              </div>
            )}

            {liveInterrupted && (
              <div className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3">
                <span className="flex items-center gap-1 text-sm font-semibold text-destructive">
                  <Radio className="w-4 h-4" /> Live stream interrupted
                </span>
                <span className="text-sm text-muted-foreground">
                  Your recording is still safe. Tap "Go Live" to start broadcasting again with the same invite link.
                </span>
              </div>
            )}

            {rosterChips}
            {statTrackerCards.length > 0 ? (
              <div className="space-y-4">{statTrackerCards}</div>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-4">Select players above to start tracking stats.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCounter({ label, made, attempt, onMake, onMiss, onUndoMake, onUndoMiss }: any) {
  return (
    <div className="flex flex-col border rounded-lg overflow-hidden bg-muted/20">
      <div className="bg-muted text-center py-1 text-xs font-bold tracking-widest text-muted-foreground">{label}</div>
      <div className="flex-1 flex flex-col items-center justify-center p-2 gap-1">
        <div className="font-mono text-xl font-bold tracking-tighter">
          <span className="text-primary">{made}</span><span className="text-muted-foreground/50">/</span><span>{attempt}</span>
        </div>
      </div>
      <div className="grid grid-cols-2 divide-x border-t">
        <Button variant="ghost" className="rounded-none h-12 hover:bg-green-500/10 hover:text-green-600 active:bg-green-500/20" onClick={onMake} onContextMenu={(e) => { e.preventDefault(); onUndoMake(); }}>
          MAKE
        </Button>
        <Button variant="ghost" className="rounded-none h-12 hover:bg-red-500/10 hover:text-red-600 active:bg-red-500/20" onClick={onMiss} onContextMenu={(e) => { e.preventDefault(); onUndoMiss(); }}>
          MISS
        </Button>
      </div>
    </div>
  );
}

function ScoreControl({ label, score, onAdd, accent }: { label: string; score: number; onAdd: (n: number) => void; accent?: boolean }) {
  return (
    <div className={`flex-1 min-w-0 flex items-center gap-2 rounded-lg border px-2 py-1.5 ${accent ? "bg-primary/5 border-primary/20" : "bg-muted/20"}`}>
      <div className="min-w-0">
        <div className="text-[10px] font-bold uppercase tracking-wide truncate text-muted-foreground leading-none">{label}</div>
        <div className={`font-mono font-bold text-2xl leading-tight ${accent ? "text-primary" : ""}`}>{score}</div>
      </div>
      <div className="flex items-center gap-0.5 ml-auto shrink-0">
        <Button variant="ghost" size="sm" className="h-7 w-6 p-0" onClick={() => onAdd(-1)}>
          <Minus className="w-3.5 h-3.5" />
        </Button>
        <Button variant="secondary" size="sm" className="h-7 w-7 p-0 text-xs font-bold" onClick={() => onAdd(1)}>+1</Button>
        <Button variant="secondary" size="sm" className="h-7 w-7 p-0 text-xs font-bold" onClick={() => onAdd(2)}>+2</Button>
        <Button variant="secondary" size="sm" className="h-7 w-7 p-0 text-xs font-bold" onClick={() => onAdd(3)}>+3</Button>
      </div>
    </div>
  );
}

function SingleStatCounter({ label, value, onInc, onDec }: any) {
  return (
    <div className="flex flex-col border rounded-lg overflow-hidden bg-muted/20">
      <div className="bg-muted text-center py-1 text-xs font-bold tracking-widest text-muted-foreground">{label}</div>
      <div className="flex-1 flex items-center justify-center p-2">
        <div className="font-mono text-2xl font-bold">{value}</div>
      </div>
      <div className="grid grid-cols-2 divide-x border-t">
        <Button variant="ghost" className="rounded-none h-12 active:bg-muted" onClick={onDec}>-</Button>
        <Button variant="ghost" className="rounded-none h-12 active:bg-muted" onClick={onInc}>+</Button>
      </div>
    </div>
  );
}
