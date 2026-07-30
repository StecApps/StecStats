import { useState, useEffect, useRef } from "react";
import { backgroundUpload, PENDING_VIDEO_UPLOAD_KEY } from "@/lib/backgroundUpload";
import { uploadVideoBlob } from "@/lib/videoUpload";
import FilmRoom from "@/components/film-room";
import SidelineMode from "@/components/sideline-mode";
import { 
  useListPlayers, 
  useListTeams,
  useCreateGame,
  useUpdateGame,
  useGetGame,
  useCreateTeam,
  useCreatePlayer,
  useGetGameHighlight,
  useGetGameLowlight,
  useGetBillingStatus,
  getGetGameHighlightQueryKey,
  getGetGameLowlightQueryKey,
  getGetGameQueryKey,
  getGetPlayerSummaryQueryKey,
  getListPlayerTeamGroupsQueryKey,
  getListTeamGamesQueryKey
} from "@workspace/api-client-react";
import { getObjectDetector, detectPersonNear, getPoseLandmarker, detectShotPose, createTrackerState, updateTracker, type TrackerState } from "@/lib/playerTracking";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useParams, useSearch } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Loader2, Plus, ArrowLeft, Minus, UserPlus, Check, X, CalendarDays, Video, Circle, Square, Play, Pause, Radio, Copy, Users, ZoomIn, ZoomOut, Aperture, Mic, MicOff, Sparkles, Download, Share2, Crosshair, Home, BarChart2, Music, Youtube } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { getIceServers, liveWsUrl, startLiveSession, stopLiveSession, watchUrlForCode } from "@/lib/liveStream";
import { AdaptiveQualityController, type AdaptiveLevel } from "@/lib/adaptiveStream";
import { Gauge } from "lucide-react";
import { createRecordingSessionId, saveChunk, getOrderedChunks, deleteSession } from "@/lib/recordingStore";
import { getSportProfile, SPORT_EMOJI } from "@/lib/sport-profiles";

type StatCounters = {
  playerId: number;
  ftMade: number; ftAttempted: number;
  twoMade: number; twoAttempted: number;
  threeMade: number; threeAttempted: number;
  assists: number; rebounds: number; steals: number;
  turnovers: number; blocks: number;
  goals: number; shots: number; shotsOffTarget: number;
  saves: number; yellowCards: number; redCards: number;
};

type GameEventEntry = {
  playerId: number;
  statField: string;
  delta: number;
  videoTimestampMs: number;
};

// Lightweight snapshot of an in-progress (unsaved) game, autosaved to
// localStorage so a crashed tab or accidental close doesn't lose the team,
// roster, score, and stat history someone was tracking live. `sessionId`
// (when present) points at the matching IndexedDB recording session so the
// video itself can also be recovered — see recordingStore.ts.
type RecordDraft = {
  version: 1;
  savedAt: number;
  sessionId: string | null;
  mimeType: string | null;
  teamId: string;
  opponent: string;
  date: string;
  teamScore: number;
  opponentScore: number;
  selectedPlayerIds: number[];
  stats: Record<number, StatCounters>;
  events: GameEventEntry[];
  elapsedMs: number;
};

const DRAFT_STORAGE_KEY = "stec:record-draft";
const DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const initialStats = (playerId: number): StatCounters => ({
  playerId, ftMade: 0, ftAttempted: 0, twoMade: 0, twoAttempted: 0, threeMade: 0, threeAttempted: 0,
  assists: 0, rebounds: 0, steals: 0, turnovers: 0, blocks: 0,
  goals: 0, shots: 0, shotsOffTarget: 0, saves: 0, yellowCards: 0, redCards: 0,
});

const STAT_LABELS: Record<string, string> = {
  ftMade: "FT Made", ftAttempted: "FT Miss", twoMade: "2PT Made", twoAttempted: "2PT Miss",
  threeMade: "3PT Made", threeAttempted: "3PT Miss", assists: "Assist", rebounds: "Rebound",
  steals: "Steal", turnovers: "Turnover", blocks: "Block",
  goals: "Goal", shots: "Shot On Target", shotsOffTarget: "Shot Off Target",
  saves: "Save", yellowCards: "Yellow Card", redCards: "Red Card",
};

function formatMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}


function videoObjectSrc(objectPath: string, downloadFilename?: string): string {
  const base = `/api/storage/objects/${objectPath.replace(/^\/objects\//, "")}`;
  return downloadFilename ? `${base}?download=${encodeURIComponent(downloadFilename)}` : base;
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

  const { data: billingStatus } = useGetBillingStatus();
  const isPro = billingStatus?.plan === "pro" || billingStatus?.plan === "premium";
  const isPremium = billingStatus?.plan === "premium";

  const { data: players } = useListPlayers();
  const { data: teams, refetch: refetchTeams } = useListTeams();
  const createTeam = useCreateTeam();
  const createPlayer = useCreatePlayer();
  const createGame = useCreateGame();
  const updateGame = useUpdateGame();
  const savingRef = useRef(false);
  const [highlightMusicTrack, setHighlightMusicTrack] = useState<string | null>(null);
  const [lowlightMusicTrack, setLowlightMusicTrack] = useState<string | null>(null);
  const [isGeneratingHighlight, setIsGeneratingHighlight] = useState(false);
  const [isGeneratingLowlight, setIsGeneratingLowlight] = useState(false);

  const { data: highlight } = useGetGameHighlight(gameId as number, {
    query: {
      enabled: isEditing,
      queryKey: getGetGameHighlightQueryKey(gameId as number),
      refetchInterval: (query) =>
        query.state.data?.status === "processing" ? 3000 : false,
    },
  });

  const { data: lowlight } = useGetGameLowlight(gameId as number, {
    query: {
      enabled: isEditing,
      queryKey: getGetGameLowlightQueryKey(gameId as number),
      refetchInterval: (query) =>
        query.state.data?.status === "processing" ? 3000 : false,
    },
  });

  const highlightFileName = () => {
    const opp = (opponent || "game").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
    return `stec-highlights-${opp || "game"}.mp4`;
  };

  // Prefetch the highlight video into memory as soon as it's ready, so Share
  // has zero network delay between the tap and calling navigator.share().
  // iOS Safari revokes the "user activation" needed for share() if too much
  // time passes after the tap — awaiting a fetch first was silently breaking
  // Share on iPhone/iPad, where it looked like the button did nothing.
  useEffect(() => {
    if (highlight?.status !== "ready" || !highlight.highlightObjectPath) return;
    const path = highlight.highlightObjectPath;
    if (highlightBlobCacheRef.current?.path === path) return;
    let cancelled = false;
    fetch(videoObjectSrc(path))
      .then((res) => (res.ok ? res.blob() : null))
      .then((blob) => {
        if (!cancelled && blob) highlightBlobCacheRef.current = { path, blob };
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [highlight?.status, highlight?.highlightObjectPath]);

  // The server only reports processing/ready/failed — not a real completion
  // percentage, since duration depends on video length and how many
  // highlight-worthy moments were tagged. Ticking a clock while "processing"
  // lets us show a genuinely moving status bar (elapsed-time based, capped
  // short of 100%) instead of a bare spinner, without pretending to know
  // exactly how much longer it'll take. The actual "ready" transition
  // (polled every 3s above) is what snaps the bar to completion.
  const [highlightNow, setHighlightNow] = useState(() => Date.now());
  useEffect(() => {
    if (highlight?.status !== "processing") return;
    setHighlightNow(Date.now());
    const id = setInterval(() => setHighlightNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [highlight?.status, highlight?.startedAt]);

  const highlightElapsedSec = highlight?.startedAt
    ? Math.max(0, (highlightNow - new Date(highlight.startedAt).getTime()) / 1000)
    : 0;
  // Time constant of 900s: bar reaches 63% at 15 min, 86% at 30 min, caps at
  // 92% around 45 min — honest for large games that take up to 55 min.
  const highlightProgressPct = Math.min(92, Math.round(100 * (1 - Math.exp(-highlightElapsedSec / 900))));
  const highlightStageText =
    highlightElapsedSec < 30   ? "Finding your best plays…" :
    highlightElapsedSec < 360  ? "Downloading source video…" :
    highlightElapsedSec < 2700 ? "Compressing video — large games take a while…" :
    highlightElapsedSec < 3300 ? "Encoding highlight clips…" :
    "Almost done — finalizing your reel…";

  const [repairSourcePath, setRepairSourcePath] = useState("");
  const [repairQuality, setRepairQuality] = useState<"original" | "720p">("original");

  const handleRepairVideo = async (sourceObjectPath?: string) => {
    if (!gameId) return;
    setIsRepairing(true);
    setRepairError(null);
    try {
      const body: Record<string, string> = {};
      if (sourceObjectPath) body.sourceObjectPath = sourceObjectPath;
      if (repairQuality === "720p") body.quality = "720p";
      const res = await fetch(`/api/games/${gameId}/repair-video`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 202) {
        // Repair is running in the background (large files take several minutes).
        // Show a persistent message and leave isRepairing true so the button stays
        // disabled. The user should refresh the page once the video is ready.
        setRepairError(null);
        toast({
          title: "Repair started",
          description: "The video is being repaired in the background — this takes a few minutes for large files. Refresh the page when done.",
        });
        return; // leave isRepairing=true to disable the button
      }
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error ?? `Server error ${res.status}`);
      }
      await queryClient.invalidateQueries({ queryKey: ["games", gameId] });
      setExistingVideoObjectPath(null);
      setVideoSignedUrl(null);
      setTimeout(() => window.location.reload(), 300);
    } catch (err) {
      setRepairError(err instanceof Error ? err.message : "Repair failed");
      setIsRepairing(false);
    } finally {
      // Don't set isRepairing=false on 202 — button stays disabled while running
    }
  };

  const handleGenerateHighlight = async () => {
    if (!gameId) return;
    highlightBlobCacheRef.current = null;
    setIsGeneratingHighlight(true);
    try {
      const body: Record<string, string> = {};
      if (highlightMusicTrack) body.musicTrack = highlightMusicTrack;
      const res = await fetch(`/api/games/${gameId}/highlight`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Failed");
      await queryClient.invalidateQueries({ queryKey: getGetGameHighlightQueryKey(gameId) });
    } catch {
      toast({ title: "Couldn't start the highlight reel", variant: "destructive" });
    } finally {
      setIsGeneratingHighlight(false);
    }
  };

  const handleCancelHighlight = async () => {
    if (!gameId) return;
    await fetch(`/api/games/${gameId}/highlight`, { method: "DELETE" });
    await queryClient.invalidateQueries({ queryKey: getGetGameHighlightQueryKey(gameId) });
  };

  const handleDownloadHighlight = () => {
    if (!highlight?.highlightObjectPath) return;
    const cached = highlightBlobCacheRef.current;
    const a = document.createElement("a");
    if (cached && cached.path === highlight.highlightObjectPath) {
      a.href = URL.createObjectURL(cached.blob);
    } else {
      // Ask the server to send Content-Disposition: attachment so browsers
      // that ignore the `download` attribute (notably iOS Safari) still
      // offer to save the file instead of just playing it inline.
      a.href = videoObjectSrc(highlight.highlightObjectPath, highlightFileName());
    }
    a.download = highlightFileName();
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (cached) setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  };

  const handleShareHighlight = async () => {
    if (!highlight?.highlightObjectPath) return;
    const nav = navigator as Navigator & { canShare?: (data?: ShareData) => boolean };
    try {
      let blob = highlightBlobCacheRef.current?.path === highlight.highlightObjectPath
        ? highlightBlobCacheRef.current.blob
        : null;
      if (!blob) {
        // Not yet prefetched (e.g. reel just finished) — fall back to
        // fetching now. This can lose iOS's share-gesture window on a slow
        // connection, so we still try, but fall through to Download below.
        setIsPreparingShare(true);
        const res = await fetch(videoObjectSrc(highlight.highlightObjectPath));
        blob = await res.blob();
        setIsPreparingShare(false);
      }
      const file = new File([blob], highlightFileName(), { type: "video/mp4" });
      if (nav.canShare && nav.canShare({ files: [file] })) {
        await nav.share({ files: [file], title: "Game Highlights" });
      } else {
        handleDownloadHighlight();
      }
    } catch (err) {
      setIsPreparingShare(false);
      // AbortError just means the user dismissed the native share sheet.
      if (err instanceof Error && err.name === "AbortError") return;
      handleDownloadHighlight();
    }
  };

  const [lowlightNow, setLowlightNow] = useState(() => Date.now());
  useEffect(() => {
    if (lowlight?.status !== "processing") return;
    setLowlightNow(Date.now());
    const id = setInterval(() => setLowlightNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [lowlight?.status, lowlight?.startedAt]);

  const lowlightElapsedSec = lowlight?.startedAt
    ? Math.max(0, (lowlightNow - new Date(lowlight.startedAt).getTime()) / 1000)
    : 0;
  // Time constant of 900s: same honest curve as highlight above.
  const lowlightProgressPct = Math.min(92, Math.round(100 * (1 - Math.exp(-lowlightElapsedSec / 900))));
  const lowlightStageText =
    lowlightElapsedSec < 30   ? "Finding misses and turnovers…" :
    lowlightElapsedSec < 360  ? "Downloading source video…" :
    lowlightElapsedSec < 2700 ? "Compressing video — large games take a while…" :
    lowlightElapsedSec < 3300 ? "Encoding lowlight clips…" :
    "Almost done — finalizing your reel…";

  const lowlightFileName = () => {
    const opp = (opponent || "game").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
    return `stec-lowlights-${opp || "game"}.mp4`;
  };

  const handleGenerateLowlight = async () => {
    if (!gameId) return;
    lowlightBlobCacheRef.current = null;
    setIsGeneratingLowlight(true);
    try {
      const body: Record<string, string> = {};
      if (lowlightMusicTrack) body.musicTrack = lowlightMusicTrack;
      const res = await fetch(`/api/games/${gameId}/lowlight`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Failed");
      await queryClient.invalidateQueries({ queryKey: getGetGameLowlightQueryKey(gameId) });
    } catch {
      toast({ title: "Couldn't start the lowlight reel", variant: "destructive" });
    } finally {
      setIsGeneratingLowlight(false);
    }
  };

  const handleCancelLowlight = async () => {
    if (!gameId) return;
    await fetch(`/api/games/${gameId}/lowlight`, { method: "DELETE" });
    await queryClient.invalidateQueries({ queryKey: getGetGameLowlightQueryKey(gameId) });
  };

  const handleDownloadLowlight = () => {
    if (!lowlight?.lowlightObjectPath) return;
    const cached = lowlightBlobCacheRef.current;
    const a = document.createElement("a");
    if (cached && cached.path === lowlight.lowlightObjectPath) {
      a.href = URL.createObjectURL(cached.blob);
    } else {
      a.href = videoObjectSrc(lowlight.lowlightObjectPath, lowlightFileName());
    }
    a.download = lowlightFileName();
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (cached) setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  };

  const handleShareLowlight = async () => {
    if (!lowlight?.lowlightObjectPath) return;
    const nav = navigator as Navigator & { canShare?: (data?: ShareData) => boolean };
    try {
      let blob = lowlightBlobCacheRef.current?.path === lowlight.lowlightObjectPath
        ? lowlightBlobCacheRef.current.blob
        : null;
      if (!blob) {
        setIsPreparingLowlightShare(true);
        const res = await fetch(videoObjectSrc(lowlight.lowlightObjectPath));
        blob = await res.blob();
        setIsPreparingLowlightShare(false);
      }
      const file = new File([blob], lowlightFileName(), { type: "video/mp4" });
      if (nav.canShare && nav.canShare({ files: [file] })) {
        await nav.share({ files: [file], title: "Game Lowlights" });
      } else {
        handleDownloadLowlight();
      }
    } catch (err) {
      setIsPreparingLowlightShare(false);
      if (err instanceof Error && err.name === "AbortError") return;
      handleDownloadLowlight();
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
  const [newTeamSport, setNewTeamSport] = useState<"basketball" | "soccer">("basketball");
  const [isAddTeamOpen, setIsAddTeamOpen] = useState(false);

  const [newPlayerName, setNewPlayerName] = useState("");
  const [isAddPlayerOpen, setIsAddPlayerOpen] = useState(false);

  const [existingVideoObjectPath, setExistingVideoObjectPath] = useState<string | null>(null);
  const [videoSignedUrl, setVideoSignedUrl] = useState<string | null>(null);
  const [events, setEvents] = useState<GameEventEntry[]>([]);
  const [videoOffsetMs, setVideoOffsetMs] = useState<number>(0);
  const [recordingQuality, setRecordingQuality] = useState<"standard" | "high">(
    () => (localStorage.getItem("recordingQuality") as "standard" | "high" | null) ?? "standard",
  );
  const [isRecording, setIsRecording] = useState(false);
  const [isRecordingPaused, setIsRecordingPaused] = useState(false);
  const [hasRecording, setHasRecording] = useState(false);
  const [recordedSegments, setRecordedSegments] = useState<Blob[]>([]);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [recordedPreviewUrl, setRecordedPreviewUrl] = useState<string | null>(null);
  const [isAssemblingBlob, setIsAssemblingBlob] = useState(false);
  const [assemblyStuckSec, setAssemblyStuckSec] = useState(0);
  const assemblyStuckIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Calling this forces the pending assembly race to resolve with null so
  // handleSave can continue saving stats without waiting for the video blob.
  const assemblyCancelRef = useRef<(() => void) | null>(null);
  const [isUploadingVideo, setIsUploadingVideo] = useState(false);
  const [uploadFailed, setUploadFailed] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadStatusText, setUploadStatusText] = useState("Uploading video…");
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [isRepairing, setIsRepairing] = useState(false);
  const [repairError, setRepairError] = useState<string | null>(null);
  const [sidelineMode, setSidelineMode] = useState(false);
  const highlightBlobCacheRef = useRef<{ path: string; blob: Blob } | null>(null);
  const lowlightBlobCacheRef = useRef<{ path: string; blob: Blob } | null>(null);
  const [isPreparingShare, setIsPreparingShare] = useState(false);
  const [isPreparingLowlightShare, setIsPreparingLowlightShare] = useState(false);

  const [isYoutubeConnected, setIsYoutubeConnected] = useState<boolean | null>(null);
  const [isYoutubeDialogOpen, setIsYoutubeDialogOpen] = useState(false);
  const [youtubeTitle, setYoutubeTitle] = useState("");
  const [youtubePrivacy, setYoutubePrivacy] = useState<"public" | "unlisted" | "private">("unlisted");
  const [isUploadingToYoutube, setIsUploadingToYoutube] = useState(false);
  const [youtubeVideoUrl, setYoutubeVideoUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!isEditing) return;
    fetch("/api/auth/youtube/status")
      .then((r) => r.json())
      .then((d: { connected: boolean }) => setIsYoutubeConnected(d.connected))
      .catch(() => setIsYoutubeConnected(false));
  }, [isEditing]);

  useEffect(() => {
    const params = new URLSearchParams(search);
    const ytParam = params.get("youtube");
    if (ytParam === "connected") {
      setIsYoutubeConnected(true);
      setYoutubeVideoUrl(null);
      setYoutubeTitle("STEC STATS Highlights");
      setIsYoutubeDialogOpen(true);
      if (gameId) navigate(`/record/${gameId}`);
    } else if (ytParam === "error") {
      toast({ title: "Couldn't connect YouTube. Please try again.", variant: "destructive" });
      if (gameId) navigate(`/record/${gameId}`);
    }
    // Intentionally empty deps — only run on mount to handle OAuth callback redirect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleUploadToYoutube = () => {
    if (!gameId) return;
    if (!isYoutubeConnected) {
      window.location.href = `/api/auth/youtube/connect?returnTo=${encodeURIComponent(`/record/${gameId}`)}`;
      return;
    }
    setYoutubeTitle(`STEC STATS — ${opponent || "Game"} Highlights`);
    setYoutubeVideoUrl(null);
    setIsYoutubeDialogOpen(true);
  };

  const handleDisconnectYoutube = async () => {
    try {
      await fetch("/api/auth/youtube", { method: "DELETE" });
      setIsYoutubeConnected(false);
      setIsYoutubeDialogOpen(false);
    } catch {
      toast({ title: "Couldn't disconnect YouTube. Please try again.", variant: "destructive" });
    }
  };

  const handleConfirmYoutubeUpload = async () => {
    if (!gameId || !youtubeTitle.trim()) return;
    setIsUploadingToYoutube(true);
    try {
      const res = await fetch(`/api/games/${gameId}/highlight/upload-youtube`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: youtubeTitle.trim(), privacyStatus: youtubePrivacy }),
      });
      const data = await res.json() as { youtubeUrl?: string; error?: string; message?: string };
      if (!res.ok) {
        if (data.error === "YOUTUBE_NOT_CONNECTED") {
          setIsYoutubeConnected(false);
          setIsYoutubeDialogOpen(false);
          toast({
            title: "YouTube connection expired",
            description: "Your YouTube connection expired — reconnecting now…",
            variant: "destructive",
          });
          window.location.href = `/api/auth/youtube/connect?returnTo=${encodeURIComponent(`/record/${gameId}`)}`;
          return;
        }
        throw new Error(data.error ?? "Upload failed");
      }
      const url = data.youtubeUrl ?? null;
      setYoutubeVideoUrl(url);
      setIsYoutubeDialogOpen(false);
      if (url) {
        toast({
          title: "Uploaded to YouTube!",
          description: (
            <a href={url} target="_blank" rel="noopener noreferrer" className="underline break-all">
              {url}
            </a>
          ),
        });
      }
    } catch (err) {
      toast({
        title: "YouTube upload failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setIsUploadingToYoutube(false);
    }
  };

  const [isLive, setIsLive] = useState(false);
  const [liveCode, setLiveCode] = useState<string | null>(null);
  const [viewerCount, setViewerCount] = useState(0);
  const [liveQuality, setLiveQuality] = useState<AdaptiveLevel | null>(null);
  const adaptiveRef = useRef<AdaptiveQualityController | null>(null);
  const [isStartingLive, setIsStartingLive] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [zoom, setZoom] = useState(1.3);
  const [canSwitchCamera, setCanSwitchCamera] = useState(false);
  const [micMuted, setMicMuted] = useState(false);
  const [focusPlayerId, setFocusPlayerId] = useState<number | null>(null);
  const [isReconnectingLive, setIsReconnectingLive] = useState(false);
  const [liveInterrupted, setLiveInterrupted] = useState(false);
  const [showRotateTip, setShowRotateTip] = useState(false);
  const [reviewIsPortrait, setReviewIsPortrait] = useState(false);
  const [showRecoveryPrompt, setShowRecoveryPrompt] = useState(false);
  const [recoveryOpponent, setRecoveryOpponent] = useState("");
  const [recoveryResolved, setRecoveryResolved] = useState(false);
  const recoveryDraftRef = useRef<RecordDraft | null>(null);

  const livePreviewRef = useRef<HTMLVideoElement | null>(null);
  const audiencePreviewRef = useRef<HTMLVideoElement | null>(null);
  const [showAudiencePip, setShowAudiencePip] = useState(true);
  const [showQuickStats, setShowQuickStats] = useState(false);
  const playbackRef = useRef<HTMLVideoElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunkSeqRef = useRef(0);
  const recordingSessionIdRef = useRef<string | null>(null);
  // Captures the async blob-assembly promise started by stopRecording() so
  // that handleSave() can await it if the user taps Save before onstop has
  // finished reading chunks out of IndexedDB.  Without this, recordedBlob
  // is still null when handleSave runs and the game is saved without video.
  const blobAssemblyPromiseRef = useRef<Promise<Blob | null> | null>(null);
  const didAttemptRecordingRef = useRef(false);
  const didDiscardVideoRef = useRef(false);
  const recordingStartRef = useRef<number>(0);
  const pauseStartTimeRef = useRef<number | null>(null);
  // Throttle for the "stat logged while recording is paused" toast.
  const lastPausedStatWarnRef = useRef<number>(0);
  const liveWsRef = useRef<WebSocket | null>(null);
  const livePeersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const liveCodeRef = useRef<string | null>(null);
  const livePregenDoneRef = useRef(false);
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
  const [autoFollowEnabled, setAutoFollowEnabled] = useState(false);
  const [isTrackingLoading, setIsTrackingLoading] = useState(false);
  const [isTracking, setIsTracking] = useState(false);
  const [courtViewSet, setCourtViewSet] = useState(false);
  const [shotPrompt, setShotPrompt] = useState<{ playerId: number; playerName: string; usageIndex: number } | null>(null);
  const [showShotUpgradeNudge, setShowShotUpgradeNudge] = useState(false);
  const [poseModelReady, setPoseModelReady] = useState(false);

  // Fetch a short-lived signed GCS URL so Chrome can play the saved video
  // directly from GCS (no proxy hop, proper range-request support).
  useEffect(() => {
    if (!gameId || !existingVideoObjectPath) { setVideoSignedUrl(null); return; }
    let cancelled = false;
    fetch(`/api/games/${gameId}/video-signed-url`)
      .then(r => r.ok ? r.json() : null)
      .then((data: { url: string } | null) => {
        if (!cancelled && data?.url) setVideoSignedUrl(data.url);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [gameId, existingVideoObjectPath]);
  const autoFollowRef = useRef(false);
  // trackCenterXRef/YRef + trackZoomRef are the SMOOTHED, actually-rendered
  // pan/zoom — only ever written by the draw loop below, at 60fps. The
  // detection tick (below, ~3fps) never writes them directly; it only
  // updates desiredXRef/YRef/ZoomRef, which the draw loop eases toward every
  // frame. This decouples what's visually on screen from the raw/noisy
  // per-tick detections, which used to make the camera visibly jump 333ms
  // worth of error in a single step.
  const trackCenterXRef = useRef(0.5);
  const trackCenterYRef = useRef(0.5);
  const trackZoomRef = useRef(1);
  const desiredXRef = useRef(0.5);
  const desiredYRef = useRef(0.5);
  const desiredZoomRef = useRef(1);
  const lastDrawTimeRef = useRef<number | null>(null);
  const lastTickTimeRef = useRef<number | null>(null);
  // Persistent identity/motion tracker for the locked player (position,
  // velocity, jersey-colour signature, miss streak) — see updateTracker().
  const trackerStateRef = useRef<TrackerState | null>(null);
  // Timestamp (ms) since the tracker first reported the lock as fully lost
  // (coast budget exhausted); null while locked/coasting. Used to hold the
  // last framing for a few seconds and prompt a re-lock before easing back
  // to the saved court view, instead of immediately panning away.
  const lostSinceRef = useRef<number | null>(null);
  const LOST_HOME_DELAY_MS = 5000;
  // CSS % position within the preview container div (including letterbox) for the ring overlay.
  const [lockedDisplayTarget, setLockedDisplayTarget] = useState<{ leftPct: number; topPct: number } | null>(null);
  const [lockLost, setLockLost] = useState(false);
  const courtViewRef = useRef({ x: 0.5, y: 0.5, zoom: 1 });
  const poseLandmarkerRef = useRef<Awaited<ReturnType<typeof getPoseLandmarker>> | null>(null);
  const poseIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastShotPromptRef = useRef(0);
  const SHOT_COOLDOWN_MS = 4500;
  const FREE_TASTE_LIMIT = 2;
  const shotDetectionUsageRef = useRef(0);
  const shotDetectionLimitNudgedRef = useRef(false);
  const shotPromptDismissRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const objectDetectorRef = useRef<Awaited<ReturnType<typeof getObjectDetector>> | null>(null);
  const detectionIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const previewContainerRef = useRef<HTMLDivElement | null>(null);
  const pinchStartDistRef = useRef<number | null>(null);
  const pinchStartZoomRef = useRef(1);
  const videoRotationRef = useRef<-90 | 0 | 90>(0);
  const MAX_ZOOM = 5;
  const IDEAL_VIDEO_CONSTRAINTS = recordingQuality === "high"
    ? { width: { ideal: 1920 }, height: { ideal: 1080 }, aspectRatio: { ideal: 16 / 9 }, frameRate: { ideal: 30 } }
    : { width: { ideal: 1280 }, height: { ideal: 720  }, aspectRatio: { ideal: 16 / 9 }, frameRate: { ideal: 30 } };
  const VIDEO_BITS_PER_SECOND = recordingQuality === "high" ? 6_000_000 : 4_000_000;

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

  const detectVideoRotation = (videoWidth: number, videoHeight: number): -90 | 0 | 90 => {
    const videoIsLandscape = videoWidth > videoHeight;

    // Use orientation APIs rather than window.innerWidth/innerHeight.
    // On iOS, innerWidth/innerHeight can lag by a full layout cycle after an
    // orientationchange event — so the 350ms delayed callback still reads stale
    // portrait dimensions.  screen.orientation.type and window.orientation
    // update synchronously with the event.
    let deviceIsLandscape: boolean;
    if (typeof screen !== "undefined" && screen.orientation?.type) {
      deviceIsLandscape = screen.orientation.type.startsWith("landscape");
    } else if (typeof (window as any).orientation === "number") {
      const wo = (window as any).orientation as number;
      deviceIsLandscape = wo === 90 || wo === -90;
    } else {
      // Desktop fallback only — these browsers always have correct innerWidth.
      deviceIsLandscape = window.innerWidth > window.innerHeight;
    }

    // If video and device orientations already match, no canvas rotation needed.
    if (videoIsLandscape === deviceIsLandscape) return 0;

    const angle = (
      typeof screen !== "undefined" && screen.orientation?.angle != null
        ? screen.orientation.angle
        : typeof (window as any).orientation === "number"
          ? (window as any).orientation
          : 0
    );
    const normalized = ((angle % 360) + 360) % 360;

    if (videoIsLandscape && !deviceIsLandscape) {
      // Portrait device, landscape camera — original case (rare on iOS).
      return normalized === 180 ? 90 : -90;
    } else {
      // Landscape device, portrait-reporting camera — iOS landscape quirk.
      // iOS getUserMedia always reports the camera as portrait (sensor native),
      // even when the device is held landscape.  We must rotate the canvas to
      // produce correct landscape output.
      //
      // IMPORTANT: screen.orientation.angle and window.orientation use OPPOSITE
      // conventions.  Do NOT mix them after normalization.
      //   screen.orientation.angle: 90 = landscape-left → need -90°
      //                            270 = landscape-right → need +90°
      //   window.orientation (old iOS): -90 = landscape-left → need -90°
      //                                  90 = landscape-right → need +90°
      if (typeof screen !== "undefined" && screen.orientation?.angle != null) {
        return screen.orientation.angle === 270 ? 90 : -90;
      } else {
        const wo = typeof (window as any).orientation === "number" ? (window as any).orientation : 0;
        return wo === 90 ? 90 : -90;
      }
    }
  };

  const stopMediaPipeline = () => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (detectionIntervalRef.current) {
      clearInterval(detectionIntervalRef.current);
      detectionIntervalRef.current = null;
    }
    autoFollowRef.current = false;
    setAutoFollowEnabled(false);
    setIsTracking(false);
    trackCenterXRef.current = 0.5;
    trackCenterYRef.current = 0.5;
    trackZoomRef.current = 1;
    desiredXRef.current = 0.5;
    desiredYRef.current = 0.5;
    desiredZoomRef.current = 1;
    trackerStateRef.current = null;
    lostSinceRef.current = null;
    setLockLost(false);
    setLockedDisplayTarget(null);
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
  const viewerIceAttemptsRef = useRef<Map<string, number>>(new Map());
  const viewerIceTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

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
          steals: s.steals, turnovers: s.turnovers, blocks: s.blocks,
          goals: s.goals ?? 0, shots: s.shots ?? 0,
          shotsOffTarget: s.shotsOffTarget ?? 0, saves: s.saves ?? 0,
          yellowCards: s.yellowCards ?? 0, redCards: s.redCards ?? 0,
        };
      });
      setStats(statsObj);
      setExistingVideoObjectPath(gameToEdit.videoObjectPath ?? null);
      setVideoOffsetMs(gameToEdit.videoOffsetMs ?? 0);
      setEvents(gameToEdit.events ?? []);
    }
  }, [isEditing, gameToEdit]);

  // Check once, on mount, for a draft left behind by a crash/close during a
  // previous unsaved recording session. Editing an existing game never has a
  // draft of its own, so autosave/recovery is scoped to new games only.
  useEffect(() => {
    if (isEditing) {
      setRecoveryResolved(true);
      return;
    }
    try {
      const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
      if (raw) {
        const draft: RecordDraft = JSON.parse(raw);
        const isFresh = Date.now() - draft.savedAt <= DRAFT_MAX_AGE_MS;
        const hasContent = (draft.selectedPlayerIds?.length ?? 0) > 0 || (draft.events?.length ?? 0) > 0;
        if (isFresh && hasContent) {
          recoveryDraftRef.current = draft;
          setRecoveryOpponent(draft.opponent || "");
          setShowRecoveryPrompt(true);
          return;
        }
      }
      localStorage.removeItem(DRAFT_STORAGE_KEY);
    } catch {
      localStorage.removeItem(DRAFT_STORAGE_KEY);
    }
    setRecoveryResolved(true);
    // Only ever run this check once, right after mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced autosave of the lightweight, cheap-to-persist parts of an
  // in-progress game (team, roster, score, stat counters, event log). This
  // is what lets someone recover "my team and stats" after a crash even when
  // the video itself can't be reassembled for some reason.
  useEffect(() => {
    if (isEditing || !recoveryResolved || showRecoveryPrompt) return;
    if (selectedPlayerIds.length === 0 && events.length === 0) return;
    const timeout = setTimeout(() => {
      const draft: RecordDraft = {
        version: 1,
        savedAt: Date.now(),
        sessionId: recordingSessionIdRef.current,
        mimeType: mediaRecorderRef.current?.mimeType ?? null,
        teamId,
        opponent,
        date: date.toISOString(),
        teamScore,
        opponentScore,
        selectedPlayerIds,
        stats,
        events,
        elapsedMs,
      };
      try {
        localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
      } catch {
        // Storage full/unavailable — autosave is best-effort, not critical path.
      }
    }, 1000);
    return () => clearTimeout(timeout);
  }, [isEditing, recoveryResolved, showRecoveryPrompt, teamId, opponent, date, teamScore, opponentScore, selectedPlayerIds, stats, events, elapsedMs]);

  const handleResumeDraft = async () => {
    const draft = recoveryDraftRef.current;
    setShowRecoveryPrompt(false);
    if (!draft) {
      setRecoveryResolved(true);
      return;
    }
    setTeamId(draft.teamId);
    setOpponent(draft.opponent);
    setDate(draft.date ? new Date(draft.date) : new Date());
    setTeamScore(draft.teamScore);
    setOpponentScore(draft.opponentScore);
    setSelectedPlayerIds(draft.selectedPlayerIds);
    setStats(draft.stats);
    setEvents(draft.events);
    setElapsedMs(draft.elapsedMs);

    if (draft.sessionId) {
      try {
        const chunks = await getOrderedChunks(draft.sessionId);
        if (chunks.length > 0) {
          const blob = new Blob(chunks, { type: draft.mimeType || "video/webm" });
          recordingSessionIdRef.current = draft.sessionId;
          setRecordedBlob(blob);
          setRecordedPreviewUrl(URL.createObjectURL(blob));
          toast({ title: "Game recovered", description: "Your team, stats, and video from before the crash are restored." });
        } else {
          toast({ title: "Stats recovered", description: "The video wasn't recoverable, but your team and stats are back." });
        }
      } catch {
        toast({ title: "Stats recovered", description: "The video wasn't recoverable, but your team and stats are back." });
      }
    } else {
      toast({ title: "Stats recovered", description: "Your team and stats from before are restored." });
    }
    setRecoveryResolved(true);
  };

  const handleDiscardDraft = () => {
    const draft = recoveryDraftRef.current;
    setShowRecoveryPrompt(false);
    localStorage.removeItem(DRAFT_STORAGE_KEY);
    if (draft?.sessionId) deleteSession(draft.sessionId).catch(() => {});
    recoveryDraftRef.current = null;
    setRecoveryResolved(true);
  };

  useEffect(() => {
    return () => {
      stopMediaPipeline();
      if (recordedPreviewUrl) URL.revokeObjectURL(recordedPreviewUrl);
      liveManualStopRef.current = true;
      adaptiveRef.current?.stop();
      adaptiveRef.current = null;
      if (liveReconnectTimeoutRef.current) clearTimeout(liveReconnectTimeoutRef.current);
      viewerIceTimeoutsRef.current.forEach(t => clearTimeout(t));
      viewerIceTimeoutsRef.current.clear();
      viewerIceAttemptsRef.current.clear();
      livePeersRef.current.forEach(pc => pc.close());
      liveWsRef.current?.close();
      if (liveCodeRef.current) stopLiveSession(liveCodeRef.current);
    };
  }, [recordedPreviewUrl]);

  useEffect(() => {
    if (!isRecording || isRecordingPaused) return;
    const interval = setInterval(() => {
      setElapsedMs(Date.now() - recordingStartRef.current);
    }, 500);
    return () => clearInterval(interval);
  }, [isRecording, isRecordingPaused]);

  useEffect(() => {
    if (isRecording && livePreviewRef.current && streamRef.current) {
      if (livePreviewRef.current.srcObject !== streamRef.current) {
        livePreviewRef.current.srcObject = streamRef.current;
      }
      livePreviewRef.current.play().catch(() => {});
    }
  }, [isRecording]);

  // Recovery: when the user returns to the app after backgrounding (iOS
  // suspends media elements on visibility loss), re-play the source video
  // and the live preview so the canvas draw loop keeps producing frames.
  useEffect(() => {
    if (!isRecording) return;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      sourceVideoRef.current?.play().catch(() => {});
      if (livePreviewRef.current && streamRef.current) {
        if (livePreviewRef.current.srcObject !== streamRef.current) {
          livePreviewRef.current.srcObject = streamRef.current;
        }
        livePreviewRef.current.play().catch(() => {});
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [isRecording]);

  // Audience PIP: when going live, attach the outgoing stream to the small
  // picture-in-picture element so the broadcaster sees the same framing
  // (object-contain, exact aspect ratio) that viewers get.
  useEffect(() => {
    const v = audiencePreviewRef.current;
    if (!v) return;
    if (isLive && streamRef.current) {
      if (v.srcObject !== streamRef.current) v.srcObject = streamRef.current;
      v.play().catch(() => {});
    } else {
      v.srcObject = null;
    }
  }, [isLive]);

  useEffect(() => {
    if (!isRecording) return;
    if (typeof window === "undefined" || !window.matchMedia) return;
    const dismissed = sessionStorage.getItem("hoops-rotate-tip-dismissed") === "1";
    if (dismissed) return;
    const mq = window.matchMedia("(orientation: portrait) and (pointer: coarse)");
    setShowRotateTip(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setShowRotateTip(e.matches && !dismissed);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, [isRecording]);

  const dismissRotateTip = () => {
    setShowRotateTip(false);
    sessionStorage.setItem("hoops-rotate-tip-dismissed", "1");
  };

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

  useEffect(() => {
    if (!isRecording) return;
    const recalc = () => {
      setTimeout(() => {
        const src = sourceVideoRef.current;
        if (!src || src.videoWidth === 0) return;
        videoRotationRef.current = detectVideoRotation(src.videoWidth, src.videoHeight);
      }, 350);
    };
    window.addEventListener("orientationchange", recalc);
    screen.orientation?.addEventListener("change", recalc);
    return () => {
      window.removeEventListener("orientationchange", recalc);
      screen.orientation?.removeEventListener("change", recalc);
    };
  }, [isRecording]);

  useEffect(() => {
    if (!autoFollowEnabled || !isRecording) {
      if (detectionIntervalRef.current) {
        clearInterval(detectionIntervalRef.current);
        detectionIntervalRef.current = null;
      }
      return;
    }
    detectionIntervalRef.current = setInterval(() => {
      const det = objectDetectorRef.current;
      const v = sourceVideoRef.current;
      if (!det || !v || v.videoWidth === 0 || v.videoHeight === 0) return;
      // Before an explicit tap-to-lock, don't auto-pan to "whichever person
      // is biggest" — in a gym that's just as likely to be a parent/spectator
      // standing closer to the sideline camera as it is the player on the
      // court, since the detector has no idea who's actually playing. The
      // camera holds its current (desired*) framing (see the "Tap your
      // player to lock focus" prompt) until the tracker is created by a tap.
      const tracker = trackerStateRef.current;
      if (!tracker) return;

      const now = performance.now();
      const dt = lastTickTimeRef.current !== null ? (now - lastTickTimeRef.current) / 1000 : 0.333;
      lastTickTimeRef.current = now;

      try {
        const result = updateTracker(det, v, tracker, dt, {
          cx:   trackCenterXRef.current,
          cy:   trackCenterYRef.current,
          zoom: trackZoomRef.current,
        });
        if (!result) return;

        if (result.lost) {
          // Coast budget exhausted — hold the last known framing (don't touch
          // desired*) and let the UI prompt a re-lock, instead of guessing at
          // a nearby player the way the old ever-widening search radius did.
          setIsTracking(false);
          if (lostSinceRef.current === null) lostSinceRef.current = now;
          setLockLost(true);
          if (now - lostSinceRef.current > LOST_HOME_DELAY_MS) {
            // Give up waiting for a re-lock tap and ease back to the saved
            // court view instead (draw loop performs the actual easing).
            const home = courtViewRef.current;
            desiredXRef.current = home.x;
            desiredYRef.current = home.y;
            desiredZoomRef.current = home.zoom;
          }
          return;
        }

        lostSinceRef.current = null;
        setLockLost(false);
        // Small hysteresis: don't flash "Searching…" for a single dropped
        // frame — the tracker is still coasting on predicted motion for a
        // few ticks before it ever reports `lost`.
        setIsTracking(result.matched || tracker.missCount < 2);

        desiredXRef.current = result.x;
        desiredYRef.current = result.y;
        const pct = rawToDisplayPct(result.x, result.y);
        if (pct) setLockedDisplayTarget(pct);

        // Adaptive zoom target so the player fills ~25% of frame height —
        // this leaves enough court context to see shots going up and in.
        // The draw loop eases toward this, it's never applied directly.
        const TARGET_FILL = 0.25;
        const rawZoom = TARGET_FILL / Math.max(0.04, result.normHeight);
        desiredZoomRef.current = Math.min(MAX_ZOOM, Math.max(1.1, rawZoom));
      } catch (err) {
        // detection failed this frame — keep current desired target
        console.error("auto-follow detection error", err);
      }
    }, 333);
    return () => {
      if (detectionIntervalRef.current) {
        clearInterval(detectionIntervalRef.current);
        detectionIntervalRef.current = null;
      }
    };
  }, [autoFollowEnabled, isRecording]);

  useEffect(() => {
    const cleanup = () => {
      if (poseIntervalRef.current) { clearInterval(poseIntervalRef.current); poseIntervalRef.current = null; }
      if (shotPromptDismissRef.current) { clearTimeout(shotPromptDismissRef.current); shotPromptDismissRef.current = null; }
      setShotPrompt(null);
      setPoseModelReady(false);
    };
    if (!isRecording || focusPlayerId === null) { cleanup(); return; }

    setPoseModelReady(false);
    getPoseLandmarker()
      .then(lm => { poseLandmarkerRef.current = lm; setPoseModelReady(true); })
      .catch(() => { setPoseModelReady(false); });

    poseIntervalRef.current = setInterval(() => {
      const lm = poseLandmarkerRef.current;
      const v = sourceVideoRef.current;
      if (!lm || !v || v.videoWidth === 0 || v.videoHeight === 0) return;
      const now = Date.now();
      if (now - lastShotPromptRef.current < SHOT_COOLDOWN_MS) return;
      try {
        if (detectShotPose(lm, v)) {
          lastShotPromptRef.current = now;
          if (!isPro) {
            if (shotDetectionUsageRef.current >= FREE_TASTE_LIMIT) {
              if (!shotDetectionLimitNudgedRef.current) {
                shotDetectionLimitNudgedRef.current = true;
                setShowShotUpgradeNudge(true);
              }
              return;
            }
            shotDetectionUsageRef.current += 1;
          }
          const usageIndex = isPro ? -1 : shotDetectionUsageRef.current;
          const player = players?.find(p => p.id === focusPlayerId);
          setShotPrompt({ playerId: focusPlayerId, playerName: player?.name ?? "Player", usageIndex });
          if (shotPromptDismissRef.current) clearTimeout(shotPromptDismissRef.current);
          shotPromptDismissRef.current = setTimeout(() => setShotPrompt(null), 5000);
        }
      } catch (err) {
        console.error("shot detection error", err);
      }
    }, 1000);

    return cleanup;
  }, [isRecording, focusPlayerId, players, isPro]);

  const startDrawLoop = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    let lastFrameTime = 0;
    let recoveryFrameCount = 0;
    const FRAME_MS = 1000 / 30; // cap at 30fps — camera max is 30fps, drawing more wastes GPU
    const draw = (timestamp: DOMHighResTimeStamp) => {
      if (timestamp - lastFrameTime < FRAME_MS) {
        rafRef.current = requestAnimationFrame(draw);
        return;
      }
      lastFrameTime = timestamp;
      // Every ~3 s (90 frames at 30 fps): if the live preview was paused by
      // iOS (backgrounding, screen-sleep, system interrupt), re-play it so the
      // canvas stream keeps reaching the screen. Also nudge the source video
      // in case it stalled — a stalled source causes a black canvas even
      // though the stream is still technically attached.
      recoveryFrameCount++;
      if (recoveryFrameCount >= 90) {
        recoveryFrameCount = 0;
        const lp = livePreviewRef.current;
        if (lp && lp.paused) lp.play().catch(() => {});
        const sv = sourceVideoRef.current;
        if (sv && sv.paused) sv.play().catch(() => {});
      }
      const v = sourceVideoRef.current;
      const c = canvasRef.current;
      if (v && c && v.videoWidth > 0 && v.videoHeight > 0) {
        const ctx = c.getContext("2d");
        if (ctx) {
          const vw = v.videoWidth;
          const vh = v.videoHeight;
          const rot = videoRotationRef.current;
          // IMPORTANT: the canvas's own width/height are the encoded recording
          // resolution and must stay FIXED for the entire recording — they are
          // set once in startRecording() and never mutated here. MediaRecorder
          // (via canvas.captureStream) locks its encoder to the first frame's
          // resolution; resizing the canvas mid-recording doesn't reflow the
          // encoder, it just squishes/stretches subsequent frames into the
          // original dimensions. If the phone is rotated mid-recording (which
          // flips `rot`), we instead letterbox/pillarbox the now
          // differently-shaped content into the fixed canvas ("contain"
          // fit, independent of how the live preview <video> is displayed
          // on screen — see the object-cover note on livePreviewRef) — so
          // the recorded file is never distorted, only black-bar padded.
          const cw = c.width;
          const ch = c.height;
          const dispW = rot !== 0 ? vh : vw;
          const dispH = rot !== 0 ? vw : vh;
          const scale = Math.min(cw / dispW, ch / dispH);

          if (autoFollowRef.current) {
            // Ease trackCenter*/trackZoom (what's actually drawn) toward
            // desired*/ (what the ~3fps detection tick last reported) every
            // frame, at a rate independent of frame timing. This is the only
            // place visible camera motion is produced — the detection tick
            // never writes trackCenter*/trackZoom directly — so a single
            // noisy or wrong-ish detection sample can only ever nudge the
            // camera a little, not snap it, and motion stays smooth even if
            // a frame is dropped or the tab briefly stalls.
            const nowMs = performance.now();
            const dt = lastDrawTimeRef.current !== null
              ? Math.min(0.25, (nowMs - lastDrawTimeRef.current) / 1000)
              : 1 / 60;
            lastDrawTimeRef.current = nowMs;

            const PAN_TAU = 0.35; // seconds — smaller = snappier, larger = smoother/laggier
            const PAN_DEAD_ZONE = 0.015; // normalised raw-video units — ignore movement smaller than this (pure jitter)
            const PAN_MAX_SLEW = 0.9; // normalised raw-video units/sec at zoom 1, scales with zoom below
            const ZOOM_TAU = 0.5;

            const dx = desiredXRef.current - trackCenterXRef.current;
            const dy = desiredYRef.current - trackCenterYRef.current;
            const dist = Math.hypot(dx, dy);
            if (dist > PAN_DEAD_ZONE) {
              const k = 1 - Math.exp(-dt / PAN_TAU);
              let stepX = dx * k;
              let stepY = dy * k;
              const stepDist = Math.hypot(stepX, stepY);
              // Pan faster at higher zoom — the same normalised movement
              // covers a much bigger fraction of the (smaller) visible crop
              // window once zoomed in — but always CLAMP the per-frame step
              // rather than reactively boosting alpha from positional error,
              // so even a bad detection sample only ever produces a bounded,
              // smooth pan rather than a snap.
              const maxStep = PAN_MAX_SLEW * Math.max(1, trackZoomRef.current) * dt;
              if (stepDist > maxStep && stepDist > 0) {
                const scale = maxStep / stepDist;
                stepX *= scale;
                stepY *= scale;
              }
              trackCenterXRef.current += stepX;
              trackCenterYRef.current += stepY;
            }

            const zk = 1 - Math.exp(-dt / ZOOM_TAU);
            trackZoomRef.current += (desiredZoomRef.current - trackZoomRef.current) * zk;
            zoomRef.current = trackZoomRef.current;
          } else {
            lastDrawTimeRef.current = null;
          }

          const z = Math.max(1, zoomRef.current);
          const sw = vw / z;
          const sh = vh / z;
          const cx = autoFollowRef.current ? trackCenterXRef.current : 0.5;
          const cy = autoFollowRef.current ? trackCenterYRef.current : 0.5;
          const sx = Math.max(0, Math.min(vw - sw, cx * vw - sw / 2));
          const sy = Math.max(0, Math.min(vh - sh, cy * vh - sh / 2));

          ctx.fillStyle = "black";
          ctx.fillRect(0, 0, cw, ch);
          ctx.save();
          ctx.translate(cw / 2, ch / 2);
          ctx.scale(scale, scale);
          if (rot !== 0) ctx.rotate((rot * Math.PI) / 180);
          ctx.drawImage(v, sx, sy, sw, sh, -vw / 2, -vh / 2, vw, vh);
          ctx.restore();
        }
      }
      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
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
      await new Promise<void>(r => {
        if (src.videoWidth > 0) { r(); return; }
        src.onloadedmetadata = () => r();
        setTimeout(r, 1000);
      });
      videoRotationRef.current = detectVideoRotation(src.videoWidth, src.videoHeight);
      currentDeviceIdRef.current = nextLens.id;
      syncLensLabel(nextLens.id);
      setZoom(1.3);
      zoomRef.current = 1.3;
    } catch {
      setCameraError("Could not switch lens on this device.");
    }
  };

  const adjustZoom = (delta: number) => {
    setZoom(z => Math.min(MAX_ZOOM, Math.max(1, Math.round((z + delta) * 10) / 10)));
  };

  const logShotFromPrompt = (type: 'twoMade' | 'threeMade' | 'twoAttempted' | 'threeAttempted') => {
    if (!shotPrompt) return;
    updateStat(shotPrompt.playerId, type, 1);
    if (shotPromptDismissRef.current) clearTimeout(shotPromptDismissRef.current);
    setShotPrompt(null);
  };

  const saveCourtView = () => {
    courtViewRef.current = { x: trackCenterXRef.current, y: trackCenterYRef.current, zoom: zoom };
    setCourtViewSet(true);
    toast({ title: "Court view saved", description: "Auto-Follow will return here when your player goes to the bench." });
  };

  /**
   * Converts a raw-video-normalised position (rx, ry) to CSS % offsets within
   * the previewContainerRef div, accounting for the current zoom, pan, rotation
   * and letterbox.
   */
  const rawToDisplayPct = (rx: number, ry: number): { leftPct: number; topPct: number } | null => {
    const container = previewContainerRef.current;
    const v = sourceVideoRef.current;
    const canvas = canvasRef.current;
    if (!container || !v || !canvas || v.videoWidth === 0) return null;
    const rect = container.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;

    const vw  = v.videoWidth;
    const vh  = v.videoHeight;
    const rot = videoRotationRef.current;
    const z   = Math.max(1, zoomRef.current);
    const cx  = trackCenterXRef.current;
    const cy  = trackCenterYRef.current;

    // Crop top-left in normalised raw-video coords.
    const cropLeft = Math.max(0, Math.min(1 - 1 / z, cx - 0.5 / z));
    const cropTop  = Math.max(0, Math.min(1 - 1 / z, cy - 0.5 / z));

    // raw → rotated-content-normalised (ndx ∈ [0,1], ndy ∈ [0,1]), against
    // the natural (unclamped) rotated content size (displayW x displayH).
    let ndx: number, ndy: number;
    if      (rot === -90) { ndx = 1 - (ry - cropTop) * z;  ndy = (rx - cropLeft) * z; }
    else if (rot ===  90) { ndx = (ry - cropTop) * z;       ndy = 1 - (rx - cropLeft) * z; }
    else                  { ndx = (rx - cropLeft) * z;      ndy = (ry - cropTop) * z; }
    ndx = Math.max(0, Math.min(1, ndx));
    ndy = Math.max(0, Math.min(1, ndy));

    // Inner letterbox: the rotated content is "contain"-fit into the FIXED
    // recording canvas (see startDrawLoop) — it may not fill the canvas
    // after a mid-recording orientation change, so map ndx/ndy into
    // canvas-pixel space accounting for that.
    const displayW = rot !== 0 ? vh : vw;
    const displayH = rot !== 0 ? vw : vh;
    const cw = canvas.width;
    const ch = canvas.height;
    const innerScale = Math.min(cw / displayW, ch / displayH);
    const innerW = displayW * innerScale;
    const innerH = displayH * innerScale;
    const innerOffX = (cw - innerW) / 2;
    const innerOffY = (ch - innerH) / 2;
    const canvasPxX = innerOffX + ndx * innerW;
    const canvasPxY = innerOffY + ndy * innerH;

    // Outer crop: the live preview video is shown via object-cover inside
    // the preview container (fills the screen, cropping overflow) rather
    // than object-contain — same centered-scale formula as letterboxing,
    // just Math.max instead of Math.min, so offsets go negative for the
    // cropped-off edges instead of positive for letterbox bars.
    const outerScale = Math.max(rect.width / cw, rect.height / ch);
    const outerOffX  = (rect.width  - cw * outerScale) / 2;
    const outerOffY  = (rect.height - ch * outerScale) / 2;

    return {
      leftPct: ((outerOffX + canvasPxX * outerScale) / rect.width)  * 100,
      topPct:  ((outerOffY + canvasPxY * outerScale) / rect.height) * 100,
    };
  };

  /**
   * Called when the user taps the live preview with auto-follow active.
   * Maps the tap through the current zoom/pan/rotation back to raw-video
   * coords, snaps to the nearest detected person, and locks the camera.
   */
  const handlePreviewTap = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!autoFollowEnabled) return;
    const container = previewContainerRef.current;
    const v = sourceVideoRef.current;
    const det = objectDetectorRef.current;
    const canvas = canvasRef.current;
    if (!container || !v || !det || !canvas || v.videoWidth === 0) return;

    const rect = container.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const rot = videoRotationRef.current;
    const z   = Math.max(1, zoomRef.current);
    const cx  = trackCenterXRef.current;
    const cy  = trackCenterYRef.current;

    // Natural (unclamped) rotated content dimensions.
    const vw = v.videoWidth;
    const vh = v.videoHeight;
    const displayW = rot !== 0 ? vh : vw;
    const displayH = rot !== 0 ? vw : vh;
    const cw = canvas.width;
    const ch = canvas.height;

    // Outer crop: the live preview video is shown via object-cover inside
    // the preview container — same centered-scale formula as letterboxing,
    // just Math.max instead of Math.min (see rawToDisplayPct).
    const outerScale = Math.max(rect.width / cw, rect.height / ch);
    const outerOffX  = (rect.width  - cw * outerScale) / 2;
    const outerOffY  = (rect.height - ch * outerScale) / 2;

    const tapX = e.clientX - rect.left;
    const tapY = e.clientY - rect.top;
    const canvasPxX = (tapX - outerOffX) / outerScale;
    const canvasPxY = (tapY - outerOffY) / outerScale;

    // Inner letterbox: the rotated content is "contain"-fit into the fixed
    // canvas (see startDrawLoop) — it may not fill the canvas after a
    // mid-recording orientation change.
    const innerScale = Math.min(cw / displayW, ch / displayH);
    const innerW = displayW * innerScale;
    const innerH = displayH * innerScale;
    const innerOffX = (cw - innerW) / 2;
    const innerOffY = (ch - innerH) / 2;
    const ndx = Math.max(0, Math.min(1, (canvasPxX - innerOffX) / innerW));
    const ndy = Math.max(0, Math.min(1, (canvasPxY - innerOffY) / innerH));

    // Crop top-left (accounts for current pan + zoom).
    const cropLeft = Math.max(0, Math.min(1 - 1 / z, cx - 0.5 / z));
    const cropTop  = Math.max(0, Math.min(1 - 1 / z, cy - 0.5 / z));

    // Canvas-normalised → raw-video-normalised (inverts the rotation + crop).
    let rawX: number, rawY: number;
    if      (rot === -90) { rawX = cropLeft + ndy / z;       rawY = cropTop + (1 - ndx) / z; }
    else if (rot ===  90) { rawX = cropLeft + (1 - ndy) / z; rawY = cropTop + ndx / z; }
    else                  { rawX = cropLeft + ndx / z;        rawY = cropTop + ndy / z; }
    rawX = Math.max(0, Math.min(1, rawX));
    rawY = Math.max(0, Math.min(1, rawY));

    // Snap to the nearest detected person; fall back to the raw tap point.
    const found = detectPersonNear(det, v, rawX, rawY);
    // If no person was detected right at the tap point, fall back to the raw
    // tap coordinates but with normHeight 0 (not a guessed value) — updateTracker
    // skips its height-consistency gate while normHeight is 0, so the very
    // first real detection tick isn't rejected for "wrong size" against a
    // guess that was never actually measured from a bounding box.
    const target = found ?? { x: rawX, y: rawY, normHeight: 0, color: null };
    // Fresh tracker each tap: brand-new position/velocity/colour state, no
    // carry-over from whatever was locked (or mis-locked) before.
    trackerStateRef.current = createTrackerState(target.x, target.y, target.normHeight, found?.color ?? null);
    lostSinceRef.current = null;
    setLockLost(false);
    // Snap the camera pan itself immediately instead of leaving it to the
    // draw loop's easing (which would look sluggish right when the user is
    // actively trying to fix a bad lock) — a manual re-lock is meant to feel
    // instant. Set both the smoothed AND desired refs so the very next draw
    // frame doesn't immediately start "catching up" from the old position.
    trackCenterXRef.current = target.x;
    trackCenterYRef.current = target.y;
    desiredXRef.current = target.x;
    desiredYRef.current = target.y;
    setIsTracking(true);

    const pct = rawToDisplayPct(target.x, target.y);
    if (pct) setLockedDisplayTarget(pct);
  };

  const toggleAutoFollow = async () => {
    if (autoFollowEnabled) {
      autoFollowRef.current = false;
      setAutoFollowEnabled(false);
      setIsTracking(false);
      setCourtViewSet(false);
      courtViewRef.current = { x: 0.5, y: 0.5, zoom: 1 };
      trackCenterXRef.current = 0.5;
      trackCenterYRef.current = 0.5;
      trackZoomRef.current = 1;
      desiredXRef.current = 0.5;
      desiredYRef.current = 0.5;
      desiredZoomRef.current = 1;
      trackerStateRef.current = null;
      lostSinceRef.current = null;
      setLockLost(false);
      setLockedDisplayTarget(null);
      return;
    }
    setIsTrackingLoading(true);
    try {
      const det = await getObjectDetector();
      objectDetectorRef.current = det;
    } catch {
      toast({ title: "Auto-follow unavailable", description: "Could not load the tracking model. Check your connection and try again.", variant: "destructive" });
      setIsTrackingLoading(false);
      return;
    }
    setIsTrackingLoading(false);
    // Seed trackZoomRef from whatever the user's current zoom is, and mirror
    // it into desiredZoomRef (and desiredX/YRef into the current pan) so the
    // draw loop's easing has nothing to correct toward yet — otherwise it
    // would immediately glide zoom back to the desiredZoomRef reset value of
    // 1 before the user has even tapped a player, contradicting "hold
    // current framing until tap."
    trackZoomRef.current = Math.max(1, zoomRef.current);
    desiredZoomRef.current = trackZoomRef.current;
    desiredXRef.current = trackCenterXRef.current;
    desiredYRef.current = trackCenterYRef.current;
    autoFollowRef.current = true;
    setAutoFollowEnabled(true);
  };

  const toggleMic = () => {
    const next = !micMuted;
    rawStreamRef.current?.getAudioTracks().forEach(t => { t.enabled = !next; });
    setMicMuted(next);
  };

  const startRecording = async () => {
    didAttemptRecordingRef.current = true;
    didDiscardVideoRef.current = false;
    setCameraError(null);
    try {
      let rawStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", ...IDEAL_VIDEO_CONSTRAINTS },
        audio: true,
      });
      currentDeviceIdRef.current = rawStream.getVideoTracks()[0]?.getSettings().deviceId ?? null;

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

        const trackW = sourceVideo.videoWidth || 1280;
        const trackH = sourceVideo.videoHeight || 720;
        const rot = detectVideoRotation(trackW, trackH);
        videoRotationRef.current = rot;

        // The recording canvas shape is locked to whatever orientation the
        // phone is in AT THE INSTANT "Record" is tapped (iteration 3 of this
        // decision — see .agents/memory/camera-canvas-pipeline.md). A prior
        // version always forced a landscape canvas to fix a bug where
        // starting portrait-then-rotating-to-landscape produced a tiny
        // double-letterboxed box, but that broke the equally-real case of a
        // deliberate, dedicated portrait recording (never rotated), which
        // then got the exact same double-letterbox treatment in reverse:
        // landscape canvas content genuinely portrait, forced into a
        // portrait-shaped preview container. Locking canvas shape to
        // rot-at-start makes BOTH dedicated-portrait and dedicated-landscape
        // sessions fit their canvas with zero letterboxing (the common
        // case). The only remaining tradeoff (same as every native camera
        // app) is a mid-recording orientation flip: the canvas keeps its
        // starting shape and the new content gets ordinary, non-distorting
        // pillarboxing/letterboxing (see draw()'s contain-fit) instead of a
        // seamless resize — acceptable since MediaRecorder can't renegotiate
        // resolution mid-stream. We mitigate this with UX (the rotate tip
        // below tells users to pick their orientation BEFORE recording).
        const canvas = document.createElement("canvas");
        canvas.width = rot !== 0 ? trackH : trackW;
        canvas.height = rot !== 0 ? trackW : trackH;
        canvasRef.current = canvas;
        setZoom(1.3);
        zoomRef.current = 1.3;
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

      chunkSeqRef.current = 0;
      const sessionId = createRecordingSessionId();
      recordingSessionIdRef.current = sessionId;
      const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
        ? "video/webm;codecs=vp9,opus"
        : MediaRecorder.isTypeSupported("video/webm")
          ? "video/webm"
          : "video/mp4";
      const recorder = new MediaRecorder(recordStream, {
        mimeType,
        videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
        audioBitsPerSecond: 128_000,
      });
      // Chunks are written straight to IndexedDB (disk-backed) instead of
      // an in-memory array — a long game otherwise accumulates gigabytes of
      // Blob data on the JS heap and reliably OOM-crashes the tab (see
      // recordingStore.ts header comment / .agents/memory for details).
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          const seq = chunkSeqRef.current++;
          saveChunk(sessionId, seq, e.data).catch(() => {});
        }
      };
      recorder.onstop = () => {
        // Defer blob assembly — don't assemble + create an object URL here.
        // For a 90-min game the blob can be multiple GB and eagerly allocating
        // it crashes mobile browser tabs (iOS kills the tab). Instead we set the
        // promise on blobAssemblyPromiseRef; handleSave awaits it right before
        // uploading. No in-memory preview URL is created until the user saves.
        blobAssemblyPromiseRef.current = getOrderedChunks(sessionId)
          .then((chunks) => {
            if (!chunks.length) return null;
            const blob = new Blob(chunks, { type: mimeType });
            setRecordedBlob(blob);
            return blob;
          })
          .catch(() => null)
          .finally(() => stopMediaPipeline());
      };

      mediaRecorderRef.current = recorder;
      recordingStartRef.current = Date.now();
      recorder.start(3000);
      setIsRecording(true);
      setHasRecording(true);
      shotDetectionUsageRef.current = 0;
      shotDetectionLimitNudgedRef.current = false;
      setShowShotUpgradeNudge(false);
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
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state === "recording") {
      const mimeType = recorder.mimeType;
      const sessionId = recordingSessionIdRef.current;
      // Store the assembly promise so handleSave() can await it when the
      // user taps Save before onstop has finished reading from IndexedDB.
      blobAssemblyPromiseRef.current = new Promise<Blob | null>((resolve) => {
        recorder.onstop = () => {
          getOrderedChunks(sessionId ?? "")
            .then((chunks) => {
              const blob = new Blob(chunks, { type: mimeType });
              setRecordedBlob(blob);
              setRecordedPreviewUrl(URL.createObjectURL(blob));
              resolve(blob);
            })
            .catch(() => resolve(null))
            .finally(() => stopMediaPipeline());
        };
      });
      recorder.stop();
    } else {
      // Recorder already stopped (was paused) — just clean up the camera.
      // All segments are already in recordedSegments; handleSave will pick them up.
      stopMediaPipeline();
    }
    setIsRecording(false);
    setIsRecordingPaused(false);
    pauseStartTimeRef.current = null;
    if (isLive) {
      stopGoingLive();
    }
  };

  const stopRecordingAsync = (): Promise<Blob | null> => {
    return new Promise((resolve) => {
      const recorder = mediaRecorderRef.current;
      if (!recorder || recorder.state !== "recording") {
        resolve(recordedBlob);
        return;
      }
      const mimeType = recorder.mimeType;
      const sessionId = recordingSessionIdRef.current;
      recorder.onstop = () => {
        getOrderedChunks(sessionId ?? "")
          .then((chunks) => {
            if (!chunks.length) { stopMediaPipeline(); resolve(null); return; }
            const blob = new Blob(chunks, { type: mimeType });
            setRecordedBlob(blob);
            stopMediaPipeline();
            resolve(blob);
          })
          .catch(() => { stopMediaPipeline(); resolve(null); });
      };
      recorder.stop();
      setIsRecording(false);
      if (isLive) stopGoingLive();
    });
  };

  // Split the current recording into a new segment WITHOUT stopping the
  // camera. The MediaRecorder is stopped (so its chunks are flushed to
  // IndexedDB and assembled into a Blob), then a fresh MediaRecorder is
  // started on the same live stream. Score, stats, and events are preserved.
  const splitRecording = async () => {
    const recorder = mediaRecorderRef.current;
    const stream = streamRef.current;
    if (!recorder || recorder.state !== "recording" || !stream) return;

    const mimeType = recorder.mimeType;
    const sessionId = recordingSessionIdRef.current ?? "";

    // Remember the wall-clock time just before we stop the recorder.
    // The gap (splitStart → newRecorder.start) is dead time that must NOT
    // appear as video time in the concatenated clip; we compensate by
    // advancing recordingStartRef so `Date.now() - recordingStartRef.current`
    // equals the actual playback position in the final concatenated video.
    const splitStart = Date.now();

    // Flush this segment — custom onstop so we skip stopMediaPipeline
    const blob = await new Promise<Blob | null>((resolve) => {
      recorder.onstop = () => {
        getOrderedChunks(sessionId)
          .then(chunks => {
            if (chunks.length === 0) {
              // Keep the IndexedDB session for recovery — do NOT delete it.
              resolve(null);
              return;
            }
            const b = new Blob(chunks, { type: mimeType });
            deleteSession(sessionId).catch(() => {});
            resolve(b);
          })
          .catch(() => resolve(null));
      };
      recorder.stop();
    });

    if (blob && blob.size > 0) {
      setRecordedSegments(prev => [...prev, blob]);
    } else {
      // The half's footage could not be read back — never lose this silently.
      toast({
        title: "Warning: half footage not saved",
        description: `The footage for half ${recordedSegments.length + 1} could not be read back from storage. Recording continues, but that half may be missing from the final video. Consider stopping and saving now.`,
        variant: "destructive",
        duration: 15000,
      });
    }

    // Fresh recorder session on the same (still-live) camera stream
    chunkSeqRef.current = 0;
    const newSessionId = createRecordingSessionId();
    recordingSessionIdRef.current = newSessionId;
    blobAssemblyPromiseRef.current = null;

    const newRecorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
      audioBitsPerSecond: 128_000,
    });
    newRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) saveChunk(newSessionId, chunkSeqRef.current++, e.data).catch(() => {});
    };
    mediaRecorderRef.current = newRecorder;
    newRecorder.start(3000);

    // Advance the recording reference clock by the gap consumed by the split
    // so that timestamps for 2nd-half stats map to the correct position in
    // the concatenated video (1st half + 2nd half with no dead-time gap).
    const gapMs = Date.now() - splitStart;
    recordingStartRef.current += gapMs;

    // Camera stays alive; isRecording stays true; stats/score preserved
  };

  // Pause recording: flush the current segment and stop the encoder, but keep
  // the camera stream alive so Resume can start a new segment instantly.
  // `recordingStartRef` is NOT advanced yet — that happens on resume when we
  // know exactly how long the pause was.
  const pauseRecording = async () => {
    const recorder = mediaRecorderRef.current;
    const stream = streamRef.current;
    if (!recorder || recorder.state !== "recording" || !stream) return;

    const mimeType = recorder.mimeType;
    const sessionId = recordingSessionIdRef.current ?? "";

    const blob = await new Promise<Blob | null>((resolve) => {
      recorder.onstop = () => {
        getOrderedChunks(sessionId)
          .then(chunks => {
            if (chunks.length === 0) {
              // Keep the IndexedDB session for recovery — do NOT delete it.
              resolve(null);
              return;
            }
            const b = new Blob(chunks, { type: mimeType });
            deleteSession(sessionId).catch(() => {});
            resolve(b);
          })
          .catch(() => resolve(null));
      };
      recorder.stop();
    });

    if (blob && blob.size > 0) {
      setRecordedSegments(prev => [...prev, blob]);
    } else {
      toast({
        title: "Warning: footage not saved",
        description: "The footage recorded so far could not be read back from storage and may be missing from the final video.",
        variant: "destructive",
        duration: 15000,
      });
    }

    pauseStartTimeRef.current = Date.now();
    setIsRecordingPaused(true);
    // isRecording stays true — camera stays alive, stats still tracked
    toast({
      title: "Recording paused",
      description: "Stats logged while paused won't be on film — they'll still count in the box score.",
    });
  };

  // Resume recording: start a fresh encoder on the same camera stream and
  // advance the reference clock by exactly how long we were paused so that
  // stat videoTimestampMs values stay aligned with the concatenated video.
  const resumeRecording = () => {
    const stream = streamRef.current;
    if (!stream || !isRecordingPaused) return;

    // Reuse the mimeType from the last recorder so all segments match
    const mimeType = mediaRecorderRef.current?.mimeType
      ?? (MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
        ? "video/webm;codecs=vp9,opus"
        : "video/webm");

    chunkSeqRef.current = 0;
    const newSessionId = createRecordingSessionId();
    recordingSessionIdRef.current = newSessionId;
    blobAssemblyPromiseRef.current = null;

    const newRecorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
      audioBitsPerSecond: 128_000,
    });
    newRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) saveChunk(newSessionId, chunkSeqRef.current++, e.data).catch(() => {});
    };
    mediaRecorderRef.current = newRecorder;
    newRecorder.start(3000);

    // Advance the reference clock by the full paused gap so timestamps for
    // stats logged after resume map to the correct position in the final
    // concatenated video (same mechanism as splitRecording).
    if (pauseStartTimeRef.current !== null) {
      const gapMs = Date.now() - pauseStartTimeRef.current;
      recordingStartRef.current += gapMs;
      pauseStartTimeRef.current = null;
    }

    setIsRecordingPaused(false);
  };

  const discardVideo = () => {
    didDiscardVideoRef.current = true;
    if (recordedPreviewUrl) URL.revokeObjectURL(recordedPreviewUrl);
    setRecordedPreviewUrl(null);
    setRecordedBlob(null);
    setRecordedSegments([]);
    setHasRecording(false);
    setExistingVideoObjectPath(null);
    setEvents([]);
    if (recordingSessionIdRef.current) {
      deleteSession(recordingSessionIdRef.current).catch(() => {});
      recordingSessionIdRef.current = null;
    }
    toast({ title: "Video discarded", description: "Your stats are kept — the game will save without a video." });
  };

  const MAX_PEER_ICE_RESTART_ATTEMPTS = 3;
  const PEER_ICE_RESTART_DELAYS_MS = [1500, 3000, 6000];

  // A relayed connection can blip (common on mobile networks/TURN under
  // load) and leave the RTCPeerConnection "disconnected"/"failed" with no
  // automatic recovery. This attempts an ICE restart on the existing peer
  // connection a few times with backoff before giving up on that viewer.
  const scheduleIceRestart = (viewerId: string) => {
    if (liveManualStopRef.current) return;
    if (viewerIceTimeoutsRef.current.has(viewerId)) return;

    const attempts = viewerIceAttemptsRef.current.get(viewerId) ?? 0;
    if (attempts >= MAX_PEER_ICE_RESTART_ATTEMPTS) {
      const pc = livePeersRef.current.get(viewerId);
      pc?.close();
      livePeersRef.current.delete(viewerId);
      viewerIceAttemptsRef.current.delete(viewerId);
      setViewerCount(livePeersRef.current.size);
      if (liveWsRef.current?.readyState === WebSocket.OPEN && liveCodeRef.current) {
        liveWsRef.current.send(JSON.stringify({
          type: "peer-connection-failed",
          code: liveCodeRef.current,
          targetId: viewerId,
        }));
      }
      return;
    }

    const delay = PEER_ICE_RESTART_DELAYS_MS[attempts] ?? 6000;
    const timeout = setTimeout(async () => {
      viewerIceTimeoutsRef.current.delete(viewerId);
      const pc = livePeersRef.current.get(viewerId);
      if (!pc || liveManualStopRef.current) return;

      const state = pc.connectionState;
      if (state === "connected") {
        viewerIceAttemptsRef.current.delete(viewerId);
        return;
      }

      viewerIceAttemptsRef.current.set(viewerId, attempts + 1);
      try {
        pc.restartIce();
        const offer = await pc.createOffer({ iceRestart: true });
        await pc.setLocalDescription(offer);
        if (liveWsRef.current?.readyState === WebSocket.OPEN && liveCodeRef.current) {
          liveWsRef.current.send(JSON.stringify({
            type: "offer",
            code: liveCodeRef.current,
            targetId: viewerId,
            sdp: offer,
            renegotiate: true,
          }));
        }
      } catch {
        // Fall through to schedule the next attempt (or give up if exhausted).
      }
      scheduleIceRestart(viewerId);
    }, delay);
    viewerIceTimeoutsRef.current.set(viewerId, timeout);
  };

  // Reorder the m=video payload list in an SDP to put H.264 first.
  // H.264 is hardware-accelerated on most phones and produces noticeably
  // better image quality than VP8 at the same bitrate.
  const preferH264inSdp = (sdp: string): string => {
    const lines = sdp.split('\n');
    const videoIdx = lines.findIndex(l => l.startsWith('m=video'));
    if (videoIdx === -1) return sdp;
    const h264Pts: string[] = [];
    for (const l of lines) {
      const m = l.match(/^a=rtpmap:(\d+) H264\//i);
      if (m) h264Pts.push(m[1]);
    }
    if (h264Pts.length === 0) return sdp;
    const mParts = lines[videoIdx].split(' ');
    const header = mParts.slice(0, 3);
    const pts = mParts.slice(3);
    lines[videoIdx] = [
      ...header,
      ...h264Pts.filter(pt => pts.includes(pt)),
      ...pts.filter(pt => !h264Pts.includes(pt)),
    ].join(' ');
    return lines.join('\n');
  };

  // Adaptive stream quality: instead of a fixed 6 Mbps cap that freezes the
  // stream whenever the venue uplink dips, a controller watches each viewer
  // connection's stats and steps the encoder bitrate/resolution down (and
  // back up) automatically. The local recording is unaffected — it captures
  // the canvas at full quality on its own pipeline.
  const ensureAdaptiveController = (): AdaptiveQualityController => {
    if (!adaptiveRef.current) {
      adaptiveRef.current = new AdaptiveQualityController(
        () => livePeersRef.current,
        (level) => setLiveQuality(level),
      );
      adaptiveRef.current.start();
    }
    return adaptiveRef.current;
  };

  const stopAdaptiveController = () => {
    adaptiveRef.current?.stop();
    adaptiveRef.current = null;
    setLiveQuality(null);
  };

  const createPeerConnectionForViewer = async (viewerId: string) => {
    const iceServers = await getIceServers();
    const pc = new RTCPeerConnection({ iceServers });
    streamRef.current?.getTracks().forEach(track => {
      if (!streamRef.current) return;
      pc.addTrack(track, streamRef.current);
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
    const handleConnectionStateChange = () => {
      const state = pc.connectionState;
      if (state === "connected") {
        viewerIceAttemptsRef.current.delete(viewerId);
        const t = viewerIceTimeoutsRef.current.get(viewerId);
        if (t) {
          clearTimeout(t);
          viewerIceTimeoutsRef.current.delete(viewerId);
        }
      } else if (state === "disconnected" || state === "failed") {
        scheduleIceRestart(viewerId);
      }
    };
    pc.onconnectionstatechange = handleConnectionStateChange;
    pc.oniceconnectionstatechange = handleConnectionStateChange;
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
        const rawOffer = await pc.createOffer();
        // Prefer H.264 before setting as local description so the codec
        // preference is baked into the offer the viewer receives.
        const preferredSdp = preferH264inSdp(rawOffer.sdp ?? "");
        const offer = new RTCSessionDescription({ type: rawOffer.type, sdp: preferredSdp });
        await pc.setLocalDescription(offer);
        ws.send(JSON.stringify({ type: "offer", code, targetId: message.viewerId, sdp: offer }));
        setViewerCount(livePeersRef.current.size);
      } else if (message.type === "answer") {
        const pc = livePeersRef.current.get(message.viewerId);
        if (pc) {
          await pc.setRemoteDescription(new RTCSessionDescription(message.sdp));
          // Apply quality settings NOW — this is the earliest point where
          // setParameters is guaranteed to work (encodings are populated
          // after the offer/answer exchange completes).
          ensureAdaptiveController().applyToPeer(pc);
        }
      } else if (message.type === "ice-candidate") {
        const pc = livePeersRef.current.get(message.viewerId);
        if (pc && message.candidate) await pc.addIceCandidate(new RTCIceCandidate(message.candidate));
      } else if (message.type === "viewer-left") {
        const pc = livePeersRef.current.get(message.viewerId);
        pc?.close();
        livePeersRef.current.delete(message.viewerId);
        viewerIceAttemptsRef.current.delete(message.viewerId);
        const t = viewerIceTimeoutsRef.current.get(message.viewerId);
        if (t) {
          clearTimeout(t);
          viewerIceTimeoutsRef.current.delete(message.viewerId);
        }
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
      viewerIceTimeoutsRef.current.forEach(t => clearTimeout(t));
      viewerIceTimeoutsRef.current.clear();
      viewerIceAttemptsRef.current.clear();
      setViewerCount(0);
      setIsLive(false);

      if (liveReconnectAttemptsRef.current >= MAX_LIVE_RECONNECT_ATTEMPTS) {
        stopAdaptiveController();
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

    // If a previous broadcast was interrupted, resume the same invite
    // code so viewers who kept the watch page open can reconnect.
    if (liveInterrupted && liveCodeRef.current) {
      connectBroadcasterSocket(liveCodeRef.current, true);
      return;
    }

    // If the code was already pre-generated (visible before tapping Go Live),
    // skip the API call and go straight to connecting.
    if (liveCodeRef.current) {
      connectBroadcasterSocket(liveCodeRef.current, false);
      return;
    }

    try {
      const code = await startLiveSession(opponent || "Opponent", teams?.find(t => t.id.toString() === teamId)?.name || "Team");
      liveCodeRef.current = code;
      setLiveCode(code);
      connectBroadcasterSocket(code, false);
    } catch (err) {
      setIsStartingLive(false);
      const description = err instanceof Error ? err.message.replace(/^HTTP \d+ [^:]*:\s*/, "") : undefined;
      toast({ title: "Could not start live stream", description, variant: "destructive" });
    }
  };

  // Pre-generate the live invite code as soon as game details are known so
  // coaches can copy and share the watch link before tapping "Go Live".
  useEffect(() => {
    if (!opponent || !teamId || livePregenDoneRef.current) return;
    livePregenDoneRef.current = true;
    const teamName = teams?.find(t => t.id.toString() === teamId)?.name || "Team";
    startLiveSession(opponent, teamName)
      .then(code => {
        liveCodeRef.current = code;
        setLiveCode(code);
      })
      .catch(() => { livePregenDoneRef.current = false; });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opponent, teamId, !!teams]);

  const stopGoingLive = () => {
    liveManualStopRef.current = true;
    stopAdaptiveController();
    if (liveReconnectTimeoutRef.current) {
      clearTimeout(liveReconnectTimeoutRef.current);
      liveReconnectTimeoutRef.current = null;
    }
    livePeersRef.current.forEach(pc => pc.close());
    livePeersRef.current.clear();
    viewerIceTimeoutsRef.current.forEach(t => clearTimeout(t));
    viewerIceTimeoutsRef.current.clear();
    viewerIceAttemptsRef.current.clear();
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

  const shareWatchLink = async () => {
    if (!liveCode) return;
    const url = watchUrlForCode(liveCode);
    const teamName = teams?.find(t => t.id.toString() === teamId)?.name ?? "the game";
    const shareData: ShareData = {
      title: `Watch ${teamName} live`,
      text: `Follow along with live stats for ${teamName}!`,
      url,
    };
    if (typeof navigator.share === "function") {
      try {
        await navigator.share(shareData);
        return;
      } catch (e: unknown) {
        // User cancelled the share sheet — no toast needed.
        if (e instanceof Error && e.name === "AbortError") return;
        // Fall through to clipboard on any other error.
      }
    }
    navigator.clipboard.writeText(url).then(() => {
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

  const updateStat = (pid: number, field: keyof StatCounters, increment: number, timestampOffsetMs = 0) => {
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

    if (isRecording && !isRecordingPaused) {
      const videoTimestampMs = Math.max(0, Date.now() - recordingStartRef.current + timestampOffsetMs);
      setEvents(prev => [...prev, { playerId: pid, statField: field, delta: increment, videoTimestampMs }]);
    } else if (isRecording && isRecordingPaused && increment > 0) {
      // Recording is paused — this stat has no footage. Remind the scorer
      // (throttled so rapid tapping doesn't stack toasts).
      const now = Date.now();
      if (now - lastPausedStatWarnRef.current > 15_000) {
        lastPausedStatWarnRef.current = now;
        toast({
          title: "Not on film",
          description: "Recording is paused — this stat counts, but there's no video for it. Tap Resume to keep filming.",
        });
      }
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

  const handleSave = async ({ skipVideo = false }: { skipVideo?: boolean } = {}) => {
    if (savingRef.current) return;
    setUploadFailed(false);
    if (!teamId || !opponent || !date || selectedPlayerIds.length === 0) {
      toast({ title: "Incomplete", description: "Select team, opponent, date, and at least one player.", variant: "destructive" });
      return;
    }
    savingRef.current = true;

    const startAssembly = () => {
      setIsAssemblingBlob(true);
      setAssemblyStuckSec(0);
      if (assemblyStuckIntervalRef.current) clearInterval(assemblyStuckIntervalRef.current);
      assemblyStuckIntervalRef.current = setInterval(() => {
        setAssemblyStuckSec(s => s + 1);
      }, 1000);
    };
    const finishAssembly = () => {
      setIsAssemblingBlob(false);
      setAssemblyStuckSec(0);
      if (assemblyStuckIntervalRef.current) {
        clearInterval(assemblyStuckIntervalRef.current);
        assemblyStuckIntervalRef.current = null;
      }
    };
    // Hard 30-second cap: if the MediaRecorder's onstop never fires (e.g.
    // the browser silently dropped the recording), resolve with null so the
    // game saves with stats-only rather than hanging forever.
    // assemblyCancelRef also lets the UI "Skip video" button trigger this early.
    const assemblyTimeout = <T,>(p: Promise<T>) => {
      let cancelFn!: () => void;
      const escape = new Promise<null>(res => {
        const id = setTimeout(() => res(null), 30_000);
        cancelFn = () => { clearTimeout(id); res(null); };
      });
      assemblyCancelRef.current = cancelFn;
      return Promise.race([p, escape]).then(r => {
        assemblyCancelRef.current = null;
        return r;
      });
    };

    let blobToUpload = recordedBlob;
    if (isRecording && !isRecordingPaused) {
      startAssembly();
      blobToUpload = await assemblyTimeout(stopRecordingAsync());
      finishAssembly();
    } else if (isRecordingPaused) {
      // Was paused when user saved — all segments are already in recordedSegments.
      // Just shut down the camera; no active recorder to drain.
      stopMediaPipeline();
      setIsRecording(false);
      setIsRecordingPaused(false);
      pauseStartTimeRef.current = null;
    } else if (!blobToUpload && blobAssemblyPromiseRef.current) {
      // The user pressed Stop then Save quickly — the onstop callback
      // is still assembling chunks from IndexedDB.  Await its promise so
      // we don't save the game with a null videoObjectPath.
      startAssembly();
      blobToUpload = await assemblyTimeout(blobAssemblyPromiseRef.current);
      finishAssembly();
    }

    // If the user recorded in multiple segments (halves), either raw-concat
    // (WebM — works fine) or mark for server-side ffmpeg merge (MP4 — iOS
    // MediaRecorder format). Raw MP4 concatenation produces an invalid file
    // because each segment starts a fresh moov atom; ffmpeg's concat demuxer
    // correctly offsets the second half's timestamps so every event is seekable.
    let segmentsToMerge: Blob[] | null = null;

    if (recordedSegments.length > 0) {
      const allParts = [...recordedSegments, ...(blobToUpload ? [blobToUpload] : [])];
      if (allParts.length > 0) {
        const mimeType = (blobToUpload ?? recordedSegments[0]).type || "video/webm";
        if (allParts.length > 1) {
          // Always merge multi-segment recordings server-side via ffmpeg.
          // Raw blob concatenation is invalid for both MP4 (each segment has
          // its own moov atom) and WebM (each segment has its own EBML header
          // with timestamps that restart from 0). ffmpeg's concat demuxer
          // correctly offsets the second half's timestamps so every event is
          // seekable and highlights land on the right moment.
          segmentsToMerge = allParts;
          blobToUpload = null;
        }
      }
    }

    const isWin = teamScore > opponentScore;
    const isTie = teamScore === opponentScore;
    const result = isWin ? 'W' : 'L'; // Backend requires W or L

    // ── Background upload path (new games only) ──────────────────────────────
    // For brand-new recordings we save the stats immediately and kick off the
    // video upload in the background so the user isn't stuck on the record
    // screen for the full upload duration (up to several minutes on mobile).
    // Edits keep the blocking upload so the in-place video is always consistent.
    const hasVideoToUpload = (segmentsToMerge || blobToUpload) && !skipVideo;
    if (hasVideoToUpload && !isEditing) {
      const bgPayload = {
        teamId: parseInt(teamId, 10),
        opponent,
        date: date.toISOString().split('T')[0],
        result: result as 'W' | 'L',
        teamScore,
        opponentScore,
        videoObjectPath: null,
        videoOffsetMs: videoOffsetMs > 0 ? videoOffsetMs : null,
        stats: Object.values(stats),
        events,
      };

      let newGameId: number;
      try {
        const created = await createGame.mutateAsync({ data: bgPayload });
        newGameId = (created as any).id;
      } catch (err) {
        savingRef.current = false;
        const description = err instanceof Error ? err.message.replace(/^HTTP \d+ [^:]*:\s*/, "") : undefined;
        toast({ title: "Error saving game", description, variant: "destructive" });
        return;
      }

      // Navigate immediately while video uploads in the background
      selectedPlayerIds.forEach(pid => {
        queryClient.invalidateQueries({ queryKey: getGetPlayerSummaryQueryKey(pid) });
        queryClient.invalidateQueries({ queryKey: getListPlayerTeamGroupsQueryKey(pid) });
      });
      queryClient.invalidateQueries({ queryKey: getListTeamGamesQueryKey(parseInt(teamId, 10)) });

      // Capture session info BEFORE clearing refs so the IndexedDB chunks
      // remain available for retry if the upload fails or the page refreshes.
      const capturedSessionId = recordingSessionIdRef.current;
      const capturedMimeType = mediaRecorderRef.current?.mimeType ?? null;

      // Persist a pending-upload marker so PendingVideoUploadRecoverer can
      // reassemble the footage from IndexedDB and retry on the next app load.
      if (capturedSessionId) {
        try {
          localStorage.setItem(PENDING_VIDEO_UPLOAD_KEY, JSON.stringify({
            gameId: newGameId,
            opponent,
            sessionId: capturedSessionId,
            mimeType: capturedMimeType,
            savedAt: Date.now(),
          }));
        } catch {}
      }

      localStorage.removeItem(DRAFT_STORAGE_KEY);
      // Do NOT deleteSession here — keep IndexedDB chunks alive until the
      // upload succeeds. Cleanup happens inside onVideoReady below.
      recordingSessionIdRef.current = null;
      navigate("/dashboard");
      toast({ title: "Game saved!", description: "Video is uploading in the background." });

      const capturedSegs = segmentsToMerge;
      const capturedBlob = blobToUpload;
      const capturedOpponent = opponent;
      const capturedGameId = newGameId;

      backgroundUpload.start(
        capturedGameId,
        capturedOpponent,
        async (onProgress) => {
          if (capturedSegs) {
            const segPaths: string[] = [];
            for (let i = 0; i < capturedSegs.length; i++) {
              const segPath = await uploadVideoBlob(capturedSegs[i], (pct) => {
                onProgress(Math.round((i / capturedSegs.length) * 85 + (pct / 100) * (85 / capturedSegs.length)));
              });
              segPaths.push(segPath);
            }
            const concatRes = await fetch('/api/storage/concat-segments', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ segmentPaths: segPaths }),
            });
            if (!concatRes.ok) throw new Error('Failed to merge video halves on server');
            const { videoObjectPath: mergedPath } = await concatRes.json();
            return mergedPath;
          } else if (capturedBlob) {
            return uploadVideoBlob(capturedBlob, onProgress);
          }
          return null;
        },
        async (objectPath) => {
          const patchRes = await fetch(`/api/games/${capturedGameId}/video`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ videoObjectPath: objectPath }),
          });
          if (!patchRes.ok) throw new Error('Failed to attach video to game');
          // Upload succeeded — clean up IndexedDB and the pending marker now.
          if (capturedSessionId) deleteSession(capturedSessionId).catch(() => {});
          try { localStorage.removeItem(PENDING_VIDEO_UPLOAD_KEY); } catch {}
          // Trigger highlight and lowlight generation (fire-and-forget)
          fetch(`/api/games/${capturedGameId}/highlight`, { method: 'POST' }).catch(() => {});
          fetch(`/api/games/${capturedGameId}/lowlight`, { method: 'POST' }).catch(() => {});
        },
      );
      return;
    }
    // ─────────────────────────────────────────────────────────────────────────

    let videoObjectPath = existingVideoObjectPath;
    if (segmentsToMerge && !skipVideo) {
      // MP4 multi-half path: upload each segment, then concat server-side
      setIsUploadingVideo(true);
      setUploadProgress(0);
      try {
        const segPaths: string[] = [];
        for (let i = 0; i < segmentsToMerge.length; i++) {
          setUploadStatusText(`Uploading half ${i + 1} of ${segmentsToMerge.length}…`);
          const segPath = await uploadVideoBlob(segmentsToMerge[i], (pct) => {
            const base = (i / segmentsToMerge!.length) * 85;
            const contrib = (pct / 100) * (85 / segmentsToMerge!.length);
            setUploadProgress(Math.round(base + contrib));
          });
          segPaths.push(segPath);
        }
        setUploadStatusText("Merging halves on server…");
        setUploadProgress(90);
        const concatRes = await fetch("/api/storage/concat-segments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ segmentPaths: segPaths }),
        });
        if (!concatRes.ok) throw new Error("Failed to merge video halves on server");
        const { videoObjectPath: mergedPath } = await concatRes.json();
        videoObjectPath = mergedPath;
        setUploadProgress(100);
      } catch (err) {
        setIsUploadingVideo(false);
        savingRef.current = false;
        setUploadFailed(true);
        toast({ title: "Video upload failed", description: "Tap 'Save stats only' to save your game without the video.", variant: "destructive" });
        return;
      }
      setIsUploadingVideo(false);
    } else if (blobToUpload && !skipVideo) {
      setIsUploadingVideo(true);
      setUploadProgress(0);
      setUploadStatusText("Uploading video…");
      try {
        videoObjectPath = await uploadVideoBlob(blobToUpload, setUploadProgress);
      } catch (err) {
        setIsUploadingVideo(false);
        savingRef.current = false;
        setUploadFailed(true);
        toast({ title: "Video upload failed", description: "Tap 'Save stats only' to save your game without the video.", variant: "destructive" });
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
      videoOffsetMs: videoOffsetMs > 0 ? videoOffsetMs : null,
      stats: Object.values(stats),
      events,
    };

    try {
      if (isEditing) {
        await updateGame.mutateAsync({ gameId: gameId as number, data: payload });
      } else {
        await createGame.mutateAsync({ data: payload });
      }

      const videoWasExpectedButMissing =
        didAttemptRecordingRef.current &&
        !didDiscardVideoRef.current &&
        !videoObjectPath;

      if (videoWasExpectedButMissing) {
        toast({
          title: isEditing ? "Game updated — no video saved" : "Game saved — no video",
          description: "Your stats were saved, but the recording wasn't captured. Open this game to try uploading it again.",
          variant: "destructive",
          duration: 8000,
        });
      } else {
        toast({ title: isEditing ? "Game updated" : "Game recorded" });
      }
      
      selectedPlayerIds.forEach(pid => {
        queryClient.invalidateQueries({ queryKey: getGetPlayerSummaryQueryKey(pid) });
        queryClient.invalidateQueries({ queryKey: getListPlayerTeamGroupsQueryKey(pid) });
      });
      queryClient.invalidateQueries({ queryKey: getListTeamGamesQueryKey(parseInt(teamId, 10)) });

      localStorage.removeItem(DRAFT_STORAGE_KEY);
      if (recordingSessionIdRef.current) {
        deleteSession(recordingSessionIdRef.current).catch(() => {});
        recordingSessionIdRef.current = null;
      }

      navigate("/dashboard");
    } catch(err) {
      savingRef.current = false;
      const description = err instanceof Error ? err.message.replace(/^HTTP \d+ [^:]*:\s*/, "") : undefined;
      toast({ title: "Error saving game", description, variant: "destructive" });
    }
  };

  const handleCreateTeam = async () => {
    if (!newTeamName) return;
    try {
      const t = await createTeam.mutateAsync({ data: { name: newTeamName, sport: newTeamSport } });
      await refetchTeams();
      setTeamId(t.id.toString());
      setIsAddTeamOpen(false);
      setNewTeamName("");
      setNewTeamSport("basketball");
    } catch(err: unknown) {
      const msg = err instanceof Error ? err.message.replace(/^HTTP \d+ [^:]*:\s*/, "") : "Failed to create team";
      toast({ title: "Error creating team", description: msg, variant: "destructive" });
    }
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

  const sportProfile = getSportProfile(teams?.find(t => t.id.toString() === teamId)?.sport);
  const sportIcon = SPORT_EMOJI[sportProfile.id];

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
            <span className="mr-1">{sportIcon}</span>
            {p.name}
          </Button>
        );
      })}
    </div>
  );

  const statTrackerCards = selectedPlayerIds.map(pid => {
    const player = players?.find(p => p.id === pid);
    const s = stats[pid] || initialStats(pid);
    const score = sportProfile.computeScore(s);

    return (
      <Card key={pid} className="border-secondary/20 shadow-md overflow-hidden @container">
        <div className="bg-muted/60 border-b border-border/60 px-4 py-2 tablet-landscape-lg:px-3 tablet-landscape-lg:py-1.5 flex justify-between items-center">
          <h3 className="font-display font-bold text-xl tablet-landscape-lg:text-base uppercase tracking-wide text-foreground">
            <span className="mr-1.5">{sportIcon}</span>{player?.name}
          </h3>
          <div className="font-display font-bold text-2xl tablet-landscape-lg:text-lg text-primary">{score} {sportProfile.scoreLabel}</div>
        </div>
        <CardContent className="p-4 tablet-landscape-lg:p-2.5 grid grid-cols-2 @lg:grid-cols-4 @4xl:grid-cols-8 gap-4 tablet-landscape-lg:gap-2 bg-card">
          {sportProfile.id === "basketball" ? (
            <>
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
            </>
          ) : (
            <>
              <SingleStatCounter label="GOAL" value={s.goals} onInc={() => updateStat(pid, 'goals', 1)} onDec={() => updateStat(pid, 'goals', -1)} />
              <SingleStatCounter label="AST" value={s.assists} onInc={() => updateStat(pid, 'assists', 1)} onDec={() => updateStat(pid, 'assists', -1)} />
              <SingleStatCounter label="SHT" value={s.shots} onInc={() => updateStat(pid, 'shots', 1)} onDec={() => updateStat(pid, 'shots', -1)} />
              <SingleStatCounter label="OFF" value={s.shotsOffTarget} onInc={() => updateStat(pid, 'shotsOffTarget', 1)} onDec={() => updateStat(pid, 'shotsOffTarget', -1)} />
              <SingleStatCounter label="SAVE" value={s.saves} onInc={() => updateStat(pid, 'saves', 1)} onDec={() => updateStat(pid, 'saves', -1)} />
              <SingleStatCounter label="TO" value={s.turnovers} onInc={() => updateStat(pid, 'turnovers', 1)} onDec={() => updateStat(pid, 'turnovers', -1)} />
              <SingleStatCounter label="YC" value={s.yellowCards} onInc={() => updateStat(pid, 'yellowCards', 1)} onDec={() => updateStat(pid, 'yellowCards', -1)} />
              <SingleStatCounter label="RC" value={s.redCards} onInc={() => updateStat(pid, 'redCards', 1)} onDec={() => updateStat(pid, 'redCards', -1)} />
            </>
          )}
        </CardContent>
      </Card>
    );
  });

  const teamName = teams?.find(t => t.id.toString() === teamId)?.name || "Team";
  const focusStats = focusPlayerId !== null ? (stats[focusPlayerId] || initialStats(focusPlayerId)) : null;
  const focusPts = focusStats ? (focusStats.twoMade * 2) + (focusStats.threeMade * 3) + focusStats.ftMade : 0;

  const liveScoreboardHud = (
    <div className="sticky top-0 z-10 -mx-3 -mt-3 mb-1 border-b bg-background/95 backdrop-blur-md p-2 tablet-landscape-lg:p-3 space-y-2">
      {/* Side-by-side on the full-width layouts (portrait phone, desktop),
          where the panel spans the whole screen and there's ample horizontal
          room for two label+3-button rows. Stacked at tablet-landscape,
          where this panel narrows to a 35%/300px side column next to the
          video — two side-by-side boxes there don't just look cramped, the
          fixed-size buttons (3 x 44px per team) literally don't fit the
          column width and get clipped off the edge of the screen. The
          column scrolls vertically, so stacking trades unused vertical room
          for the horizontal room the buttons actually need. */}
      <div className="flex flex-row tablet-landscape:flex-col items-stretch gap-2">
        <ScoreControl label={teamName} score={teamScore} accent
          onAdd={(n: number) => setTeamScore(s => Math.max(0, s + n))} />
        <ScoreControl label={opponent || "Opponent"} score={opponentScore}
          onAdd={(n: number) => setOpponentScore(s => Math.max(0, s + n))} />
      </div>
      {selectedPlayerIds.length > 0 && focusPlayerId !== null && focusStats && (
        <div className="flex flex-col gap-1.5">
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
          <div className="flex items-center gap-1.5 text-[11px]">
            {poseModelReady ? (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
                <span className="text-green-500 font-medium">Shot detection ready</span>
              </>
            ) : (
              <>
                <Loader2 className="w-3 h-3 animate-spin text-muted-foreground shrink-0" />
                <span className="text-muted-foreground">Loading shot detection…</span>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="flex flex-col space-y-6 pb-40 md:pb-24">
      {sidelineMode && isRecording && (
        <SidelineMode
          players={(players ?? []).filter(p => selectedPlayerIds.includes(p.id))}
          stats={stats}
          updateStat={updateStat}
          teamName={teams?.find(t => t.id.toString() === teamId)?.name ?? "Team"}
          opponent={opponent}
          teamScore={teamScore}
          opponentScore={opponentScore}
          onClose={() => setSidelineMode(false)}
          sportProfile={sportProfile}
        />
      )}
      <Dialog open={showRecoveryPrompt} onOpenChange={(open) => { if (!open) handleDiscardDraft(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Resume unsaved game?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            We found stats{recoveryDraftRef.current?.sessionId ? " and video" : ""} from an interrupted session
            {recoveryOpponent ? ` vs ${recoveryOpponent}` : ""} that never got saved. Resume it, or discard and start fresh.
          </p>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={handleDiscardDraft}>Discard</Button>
            <Button onClick={handleResumeDraft}>Resume game</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate("/dashboard")}><ArrowLeft className="w-5 h-5" /></Button>
        <h1 className="flex items-center gap-3 text-4xl font-display font-bold uppercase tracking-tight text-foreground">
          <span className="w-1.5 h-8 rounded-full bg-primary shadow-[0_0_12px_hsl(var(--primary)/0.6)]" />
          {isEditing ? "Edit Game" : "Record Game"}
        </h1>
        {isRecording && selectedPlayerIds.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto border-primary/50 text-primary hover:bg-primary hover:text-primary-foreground font-bold uppercase tracking-wide gap-2"
            onClick={() => setSidelineMode(true)}
          >
            <Radio className="w-3.5 h-3.5 animate-pulse" />
            Sideline Mode
          </Button>
        )}
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
                  <div className="space-y-4 py-2">
                    <Input value={newTeamName} onChange={e => setNewTeamName(e.target.value)} placeholder="e.g. 2024 Summer League" />
                    <div className="space-y-1.5">
                      <Label className="text-sm">Sport</Label>
                      <div className="flex gap-2">
                        {(["basketball", "soccer"] as const).map(s => (
                          <Button
                            key={s}
                            type="button"
                            variant={newTeamSport === s ? "default" : "outline"}
                            className="flex-1 capitalize"
                            onClick={() => setNewTeamSport(s)}
                          >{s}</Button>
                        ))}
                      </div>
                    </div>
                  </div>
                  <DialogFooter>
                    <Button onClick={handleCreateTeam} disabled={!newTeamName.trim() || createTeam.isPending}>
                      {createTeam.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                      Add
                    </Button>
                  </DialogFooter>
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
            <div className={`flex items-center gap-2 text-sm font-semibold ${isRecordingPaused ? "text-amber-400" : "text-red-600"}`}>
              <span className={`w-2 h-2 rounded-full shrink-0 ${isRecordingPaused ? "bg-amber-400" : "bg-red-500 animate-pulse"}`} />
              {isRecordingPaused
                ? "Paused — tap Resume when she's back in"
                : `Recording — ${formatMs(elapsedMs)}`}
            </div>
          )}

          {!isRecording && (recordedPreviewUrl || existingVideoObjectPath) && (
            <div className="space-y-3">
              <video
                ref={playbackRef}
                src={recordedPreviewUrl || videoSignedUrl || undefined}
                controls
                playsInline
                preload="none"
                onLoadedMetadata={(e) => {
                  const v = e.currentTarget;
                  setReviewIsPortrait(v.videoWidth > 0 && v.videoHeight > v.videoWidth);
                }}
                onError={(e) => {
                  const v = e.currentTarget;
                  const err = v.error;
                  const codes: Record<number, string> = {
                    1: "MEDIA_ERR_ABORTED", 2: "MEDIA_ERR_NETWORK",
                    3: "MEDIA_ERR_DECODE", 4: "MEDIA_ERR_SRC_NOT_SUPPORTED",
                  };
                  const msg = err ? `${codes[err.code] ?? `code ${err.code}`}: ${err.message || "(no message)"}` : "unknown error";
                  console.error("[video error]", msg, v.src);
                  // Show a visible banner if the game video (not a local blob) fails
                  if (!recordedPreviewUrl) {
                    const banner = document.createElement("p");
                    banner.style.cssText = "color:#f87171;font-size:0.8rem;text-align:center;padding:4px";
                    banner.textContent = `⚠ Video error: ${msg}`;
                    v.parentElement?.appendChild(banner);
                  }
                }}
                className="block w-auto max-w-full max-h-[70vh] mx-auto rounded-lg bg-black landscape:max-h-none landscape:w-[62vw]"
              />
              {reviewIsPortrait && (
                <p className="text-xs text-muted-foreground">
                  Portrait clip — will show with black bars when watched on a landscape screen.
                </p>
              )}
              <FilmRoom
                videoRef={playbackRef}
                events={events}
                players={players ?? []}
                videoOffsetMs={videoOffsetMs}
                videoDurationMs={gameToEdit?.videoDurationMs ?? null}
                videoHalf2StartMs={gameToEdit?.videoHalf2StartMs ?? null}
                videoHalftimeGapMs={gameToEdit?.videoHalftimeGapMs ?? null}
              />
              {existingVideoObjectPath && !recordedPreviewUrl && (
                <div className="max-w-md space-y-1">
                  <Label className="text-xs text-muted-foreground">
                    Video offset <span className="font-normal">(seconds to skip at start of recording clock)</span>
                  </Label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={videoOffsetMs > 0 ? Math.round(videoOffsetMs / 1000) : ""}
                      placeholder="0"
                      onChange={e => {
                        const secs = parseInt(e.target.value, 10);
                        setVideoOffsetMs(isNaN(secs) || secs <= 0 ? 0 : secs * 1000);
                      }}
                      className="w-28 h-8 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                    <span className="text-xs text-muted-foreground">sec — use this when the video covers only part of the game</span>
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
              {existingVideoObjectPath && !recordedPreviewUrl && gameId && (
                <div className="pt-1 space-y-1">
                  <div className="flex items-center gap-3 flex-wrap">
                    <p className="text-xs text-muted-foreground">
                      Video not playing correctly?{" "}
                      <button
                        type="button"
                        className="underline text-primary disabled:opacity-50"
                        onClick={() => handleRepairVideo()}
                        disabled={isRepairing}
                      >
                        {isRepairing ? "Repairing… (may take a few minutes)" : "Repair video"}
                      </button>
                    </p>
                    <div className="flex rounded-md border border-border overflow-hidden text-xs font-medium">
                      <button
                        type="button"
                        className={`px-2 py-0.5 ${repairQuality === "original" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
                        onClick={() => setRepairQuality("original")}
                      >
                        Original quality
                      </button>
                      <button
                        type="button"
                        className={`px-2 py-0.5 ${repairQuality === "720p" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
                        onClick={() => setRepairQuality("720p")}
                      >
                        720p
                      </button>
                    </div>
                  </div>
                  <details className="text-xs text-muted-foreground">
                    <summary className="cursor-pointer select-none">Re-repair from original source</summary>
                    <div className="mt-1 flex gap-2 items-center">
                      <input
                        type="text"
                        value={repairSourcePath}
                        onChange={e => setRepairSourcePath(e.target.value)}
                        placeholder="/objects/uploads/1/original-uuid"
                        className="flex-1 border border-border rounded px-2 py-0.5 bg-background text-xs font-mono"
                      />
                      <button
                        type="button"
                        className="underline text-primary disabled:opacity-50 whitespace-nowrap"
                        disabled={isRepairing || !repairSourcePath.startsWith("/objects/")}
                        onClick={() => handleRepairVideo(repairSourcePath)}
                      >
                        Re-repair
                      </button>
                    </div>
                  </details>
                  {repairError && <p className="text-xs text-destructive">{repairError}</p>}
                </div>
              )}
              <p className="text-xs text-muted-foreground">Keep this video to save it with the game, or discard it to save your stats only.</p>
            </div>
          )}

          {!isRecording && hasRecording && !recordedPreviewUrl && !existingVideoObjectPath && !isAssemblingBlob && (
            <div className="flex items-center gap-2 py-1 text-sm font-medium text-green-500">
              <Check className="w-4 h-4 shrink-0" />
              <span>Video captured — save the game below to upload it</span>
            </div>
          )}

          {!isRecording && !hasRecording && !recordedPreviewUrl && !existingVideoObjectPath && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Recording quality:</span>
                <div className="flex rounded-md border border-border overflow-hidden text-xs font-medium">
                  <button
                    type="button"
                    onClick={() => { setRecordingQuality("standard"); localStorage.setItem("recordingQuality", "standard"); }}
                    className={`px-3 py-1 transition-colors ${recordingQuality === "standard" ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground"}`}
                  >
                    Standard
                  </button>
                  <button
                    type="button"
                    onClick={() => { setRecordingQuality("high"); localStorage.setItem("recordingQuality", "high"); }}
                    className={`px-3 py-1 transition-colors ${recordingQuality === "high" ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground"}`}
                  >
                    High (1080p)
                  </button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                {recordingQuality === "standard"
                  ? "720p · ~30 MB/min · highlight reels generate ~3× faster"
                  : "1080p · ~45 MB/min · larger file, slower reel generation"}
              </p>
              <Button variant="outline" onClick={startRecording}>
                <Circle className="w-4 h-4 mr-2 text-red-500" /> Start Recording
              </Button>
              <p className="text-xs text-muted-foreground">
                Tip: hold your phone in the orientation you plan to film in (landscape is recommended) before you tap Start — rotating mid-recording will letterbox the video instead of filling the frame.
              </p>
            </div>
          )}

          {!isRecording && (
            <div className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2.5 space-y-1.5">
              <p className="text-xs font-semibold uppercase tracking-wide text-primary flex items-center gap-1.5">
                <Radio className="w-3.5 h-3.5" /> Live stream link
              </p>
              {liveCode ? (
                <>
                  <p className="text-xs text-muted-foreground break-all font-mono">{watchUrlForCode(liveCode)}</p>
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={shareWatchLink}>
                    <Share2 className="w-3 h-3 mr-1.5" /> Share link
                  </Button>
                  <p className="text-xs text-muted-foreground">Share this now — viewers can open it and wait for you to tap Go Live.</p>
                </>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">Get a shareable watch link to send before the game starts.</p>
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={async () => {
                    try {
                      const teamName = teams?.find(t => t.id.toString() === teamId)?.name || "Team";
                      const code = await startLiveSession(opponent || "Game", teamName);
                      liveCodeRef.current = code;
                      setLiveCode(code);
                      livePregenDoneRef.current = true;
                    } catch {
                      toast({ title: "Couldn't generate link", variant: "destructive" });
                    }
                  }}>
                    <Radio className="w-3 h-3 mr-1.5" /> Get Link
                  </Button>
                </>
              )}
            </div>
          )}

          {isAssemblingBlob && (
            <div className="max-w-md space-y-2">
              <p className="text-sm text-muted-foreground flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                Preparing video…{assemblyStuckSec > 0 ? ` (${assemblyStuckSec}s)` : ""}
              </p>
              {assemblyStuckSec >= 10 && (
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/8 px-3 py-2 space-y-1.5">
                  <p className="text-xs text-amber-700 dark:text-amber-400 font-medium">
                    Taking longer than expected. Your stats are safe.
                  </p>
                  <button
                    type="button"
                    className="text-xs font-semibold text-primary underline underline-offset-2 hover:opacity-80"
                    onClick={() => {
                      assemblyCancelRef.current?.();
                    }}
                  >
                    Skip video — save stats only
                  </button>
                </div>
              )}
            </div>
          )}

          {isUploadingVideo && (
            <div className="max-w-md space-y-1.5">
              <p className="text-sm text-muted-foreground flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> {uploadStatusText} {uploadProgress}%
              </p>
              <Progress value={uploadProgress} />
            </div>
          )}

          {isEditing && existingVideoObjectPath && !recordedPreviewUrl && (
            <div className="space-y-3">
            <div className="max-w-md rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-3">
              <div className="flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-primary" />
                <span className="font-display font-bold uppercase tracking-wide text-foreground">Highlight Reel</span>
              </div>

              {highlight?.onFilmMoments != null && highlight.onFilmMoments < highlight.eligibleMoments && (
                <p className="text-xs rounded-md bg-amber-500/10 text-amber-400 px-3 py-2">
                  The recording ended before the game did — only {highlight.onFilmMoments} of {highlight.eligibleMoments} highlight
                  moment{highlight.eligibleMoments === 1 ? "" : "s"} {highlight.onFilmMoments === 1 ? "is" : "are"} on film.
                  The rest happened after the video stopped and can't be in the reel.
                </p>
              )}

              {highlight && highlight.eligibleMoments === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Tag some made shots, rebounds, assists, steals or blocks during the game to build a highlight reel.
                </p>
              ) : highlight?.status === "processing" ? (
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" /> {highlightStageText}
                  </p>
                  <Progress value={highlightProgressPct} />
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs text-muted-foreground">This can take a minute — feel free to keep tapping stats while it builds.</p>
                    <button
                      onClick={handleCancelHighlight}
                      className="text-xs text-muted-foreground underline underline-offset-2 shrink-0 hover:text-foreground transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : highlight?.status === "ready" && highlight.highlightObjectPath ? (
                <div className="space-y-3">
                  <div className="relative inline-block w-auto max-w-full mx-auto">
                    <video
                      src={videoObjectSrc(highlight.highlightObjectPath)}
                      controls
                      playsInline
                      preload="none"
                      className="block w-auto max-w-full max-h-[70vh] rounded-lg bg-black landscape:max-h-none landscape:w-[62vw]"
                    />
                    <a
                      href="https://stecstats.com"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="absolute top-2 right-2 flex items-center gap-0.5 opacity-75 hover:opacity-100 transition-opacity drop-shadow-[0_1px_3px_rgba(0,0,0,0.8)]"
                    >
                      <img src="/logo.png" alt="StecStats" className="h-6 w-auto object-contain" />
                      <span className="text-white font-bold text-[11px] leading-none">.com</span>
                    </a>
                  </div>
                  <div className="flex items-center gap-2">
                    <Music className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    <span className="text-xs text-muted-foreground">Music</span>
                    <Select value={highlightMusicTrack ?? "none"} onValueChange={v => setHighlightMusicTrack(v === "none" ? null : v)}>
                      <SelectTrigger className="h-7 w-32 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No music</SelectItem>
                        <SelectItem value="energetic">Energetic</SelectItem>
                        <SelectItem value="upbeat">Upbeat</SelectItem>
                        <SelectItem value="dynamic">Dynamic</SelectItem>
                        <SelectItem value="cinematic">Cinematic</SelectItem>
                        <SelectItem value="oldschool">Old School</SelectItem>
                        <SelectItem value="lofi">Lo-Fi</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button type="button" onClick={handleShareHighlight} disabled={isPreparingShare}>
                      {isPreparingShare ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Share2 className="w-4 h-4 mr-2" />} Share
                    </Button>
                    <Button type="button" variant="outline" onClick={handleDownloadHighlight}>
                      <Download className="w-4 h-4 mr-2" /> Download
                    </Button>
                    {isPro && (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={handleUploadToYoutube}
                        disabled={isYoutubeConnected === null}
                      >
                        <Youtube className="w-4 h-4 mr-2" />
                        {isYoutubeConnected ? "YouTube" : "Connect YouTube"}
                      </Button>
                    )}
                    <Button type="button" variant="ghost" onClick={handleGenerateHighlight} disabled={isGeneratingHighlight}>
                      {isGeneratingHighlight ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Sparkles className="w-4 h-4 mr-2" />}
                      Regenerate
                    </Button>
                  </div>
                  {isPro && (
                    <Dialog
                      open={isYoutubeDialogOpen}
                      onOpenChange={(open) => {
                        if (!isUploadingToYoutube) setIsYoutubeDialogOpen(open);
                      }}
                    >
                      <DialogContent>
                        <DialogHeader>
                          <DialogTitle>Upload to YouTube</DialogTitle>
                        </DialogHeader>
                        {youtubeVideoUrl ? (
                          <div className="space-y-3">
                            <p className="text-sm text-muted-foreground">Uploaded successfully!</p>
                            <a
                              href={youtubeVideoUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-primary underline text-sm break-all block"
                            >
                              {youtubeVideoUrl}
                            </a>
                          </div>
                        ) : (
                          <div className="space-y-4 pt-1">
                            <div className="flex justify-end">
                              <button
                                type="button"
                                className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                                onClick={handleDisconnectYoutube}
                                disabled={isUploadingToYoutube}
                              >
                                Switch account
                              </button>
                            </div>
                            <div className="space-y-1.5">
                              <Label htmlFor="yt-title">Title</Label>
                              <Input
                                id="yt-title"
                                value={youtubeTitle}
                                onChange={(e) => setYoutubeTitle(e.target.value)}
                                maxLength={100}
                                disabled={isUploadingToYoutube}
                              />
                            </div>
                            <div className="space-y-1.5">
                              <Label>Privacy</Label>
                              <Select
                                value={youtubePrivacy}
                                onValueChange={(v) => setYoutubePrivacy(v as "public" | "unlisted" | "private")}
                                disabled={isUploadingToYoutube}
                              >
                                <SelectTrigger>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="unlisted">Unlisted (link-only)</SelectItem>
                                  <SelectItem value="public">Public</SelectItem>
                                  <SelectItem value="private">Private</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                            {isUploadingToYoutube && (
                              <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                Uploading to YouTube — this may take a few minutes for large videos…
                              </p>
                            )}
                          </div>
                        )}
                        <DialogFooter>
                          {youtubeVideoUrl ? (
                            <Button type="button" onClick={() => setIsYoutubeDialogOpen(false)}>
                              Done
                            </Button>
                          ) : (
                            <>
                              <Button
                                type="button"
                                variant="outline"
                                onClick={() => setIsYoutubeDialogOpen(false)}
                                disabled={isUploadingToYoutube}
                              >
                                Cancel
                              </Button>
                              <Button
                                type="button"
                                onClick={handleConfirmYoutubeUpload}
                                disabled={isUploadingToYoutube || !youtubeTitle.trim()}
                              >
                                {isUploadingToYoutube ? (
                                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Uploading…</>
                                ) : (
                                  "Upload to YouTube"
                                )}
                              </Button>
                            </>
                          )}
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">
                    Turn this game into one shareable clip of only the best plays{highlight ? ` — ${highlight.eligibleMoments} moment${highlight.eligibleMoments === 1 ? "" : "s"} found` : ""}.
                  </p>
                  {highlight?.status === "failed" && highlight.error && (
                    <p className="text-sm text-destructive">{highlight.error}</p>
                  )}
                  <div className="flex items-center gap-2">
                    <Music className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    <span className="text-xs text-muted-foreground">Music</span>
                    <Select value={highlightMusicTrack ?? "none"} onValueChange={v => setHighlightMusicTrack(v === "none" ? null : v)}>
                      <SelectTrigger className="h-7 w-32 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No music</SelectItem>
                        <SelectItem value="energetic">Energetic</SelectItem>
                        <SelectItem value="upbeat">Upbeat</SelectItem>
                        <SelectItem value="dynamic">Dynamic</SelectItem>
                        <SelectItem value="cinematic">Cinematic</SelectItem>
                        <SelectItem value="oldschool">Old School</SelectItem>
                        <SelectItem value="lofi">Lo-Fi</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <Button type="button" onClick={handleGenerateHighlight} disabled={isGeneratingHighlight}>
                    {isGeneratingHighlight ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Sparkles className="w-4 h-4 mr-2" />}
                    {highlight?.status === "failed" ? "Try Again" : "Generate Highlight Reel"}
                  </Button>
                </div>
              )}
            </div>

            {isPro && (
              <div className="max-w-md rounded-lg border border-orange-500/30 bg-orange-500/5 p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <BarChart2 className="w-5 h-5 text-orange-400" />
                  <span className="font-display font-bold uppercase tracking-wide text-foreground">Lowlight Reel</span>
                  <span className="text-xs text-muted-foreground font-normal normal-case">— misses &amp; turnovers</span>
                </div>

                {lowlight?.onFilmMoments != null && lowlight.onFilmMoments < lowlight.eligibleMoments && (
                  <p className="text-xs rounded-md bg-amber-500/10 text-amber-400 px-3 py-2">
                    The recording ended before the game did — only {lowlight.onFilmMoments} of {lowlight.eligibleMoments} lowlight
                    moment{lowlight.eligibleMoments === 1 ? "" : "s"} {lowlight.onFilmMoments === 1 ? "is" : "are"} on film.
                    The rest happened after the video stopped and can't be in the reel.
                  </p>
                )}

                {lowlight && lowlight.eligibleMoments === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Tag missed shots or turnovers during the game to build a lowlight reel for review.
                  </p>
                ) : lowlight?.status === "processing" ? (
                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" /> {lowlightStageText}
                    </p>
                    <Progress value={lowlightProgressPct} />
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs text-muted-foreground">Building your lowlight reel — this can take a minute.</p>
                      <button
                        onClick={handleCancelLowlight}
                        className="text-xs text-muted-foreground underline underline-offset-2 shrink-0 hover:text-foreground transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : lowlight?.status === "ready" && lowlight.lowlightObjectPath ? (
                  <div className="space-y-3">
                    <div className="relative inline-block w-auto max-w-full mx-auto">
                      <video
                        src={videoObjectSrc(lowlight.lowlightObjectPath)}
                        controls
                        playsInline
                        preload="none"
                        className="block w-auto max-w-full max-h-[70vh] rounded-lg bg-black landscape:max-h-none landscape:w-[62vw]"
                      />
                      <a
                        href="https://stecstats.com"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="absolute top-2 right-2 flex items-center gap-0.5 opacity-75 hover:opacity-100 transition-opacity drop-shadow-[0_1px_3px_rgba(0,0,0,0.8)]"
                      >
                        <img src="/logo.png" alt="StecStats" className="h-6 w-auto object-contain" />
                        <span className="text-white font-bold text-[11px] leading-none">.com</span>
                      </a>
                    </div>
                    <div className="flex items-center gap-2">
                      <Music className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                      <span className="text-xs text-muted-foreground">Music</span>
                      <Select value={lowlightMusicTrack ?? "none"} onValueChange={v => setLowlightMusicTrack(v === "none" ? null : v)}>
                        <SelectTrigger className="h-7 w-32 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">No music</SelectItem>
                          <SelectItem value="energetic">Energetic</SelectItem>
                          <SelectItem value="upbeat">Upbeat</SelectItem>
                          <SelectItem value="dynamic">Dynamic</SelectItem>
                          <SelectItem value="cinematic">Cinematic</SelectItem>
                          <SelectItem value="oldschool">Old School</SelectItem>
                          <SelectItem value="lofi">Lo-Fi</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button type="button" onClick={handleShareLowlight} disabled={isPreparingLowlightShare}>
                        {isPreparingLowlightShare ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Share2 className="w-4 h-4 mr-2" />} Share
                      </Button>
                      <Button type="button" variant="outline" onClick={handleDownloadLowlight}>
                        <Download className="w-4 h-4 mr-2" /> Download
                      </Button>
                      <Button type="button" variant="ghost" onClick={handleGenerateLowlight} disabled={isGeneratingLowlight}>
                        {isGeneratingLowlight ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <BarChart2 className="w-4 h-4 mr-2" />}
                        Regenerate
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">
                      Build a review reel of every miss and turnover from this game{lowlight ? ` — ${lowlight.eligibleMoments} moment${lowlight.eligibleMoments === 1 ? "" : "s"} found` : ""}.
                    </p>
                    {lowlight?.status === "failed" && lowlight.error && (
                      <p className="text-sm text-destructive">{lowlight.error}</p>
                    )}
                    <div className="flex items-center gap-2">
                      <Music className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                      <span className="text-xs text-muted-foreground">Music</span>
                      <Select value={lowlightMusicTrack ?? "none"} onValueChange={v => setLowlightMusicTrack(v === "none" ? null : v)}>
                        <SelectTrigger className="h-7 w-32 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">No music</SelectItem>
                          <SelectItem value="energetic">Energetic</SelectItem>
                          <SelectItem value="upbeat">Upbeat</SelectItem>
                          <SelectItem value="dynamic">Dynamic</SelectItem>
                          <SelectItem value="cinematic">Cinematic</SelectItem>
                          <SelectItem value="oldschool">Old School</SelectItem>
                          <SelectItem value="lofi">Lo-Fi</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <Button type="button" onClick={handleGenerateLowlight} disabled={isGeneratingLowlight}>
                      {isGeneratingLowlight ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <BarChart2 className="w-4 h-4 mr-2" />}
                      {lowlight?.status === "failed" ? "Try Again" : "Generate Lowlight Reel"}
                    </Button>
                  </div>
                )}
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
        <div className="container max-w-screen-2xl mx-auto flex justify-between items-center gap-3">
          <div className="font-display font-bold text-2xl uppercase shrink-0">
            <span className="text-primary">{teamScore}</span>
            <span className="mx-2 text-muted-foreground">-</span>
            <span>{opponentScore}</span>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            {uploadFailed && (
              <Button size="sm" variant="outline" className="text-xs h-8 px-3" onClick={() => handleSave({ skipVideo: true })} disabled={createGame.isPending || updateGame.isPending}>
                Save stats only (no video)
              </Button>
            )}
            <Button size="lg" className="font-display text-xl uppercase tracking-wider px-12 h-14" onClick={() => handleSave()} disabled={createGame.isPending || updateGame.isPending || isAssemblingBlob || isUploadingVideo}>
              {(createGame.isPending || updateGame.isPending) && <Loader2 className="w-5 h-5 mr-2 animate-spin" />}
              Save Game
            </Button>
          </div>
        </div>
      </div>

      {isRecording && (
        <div className="fixed inset-0 z-[9999] flex flex-col tablet-landscape:flex-row bg-black">
          <div ref={previewContainerRef} className="relative flex-[5] tablet-landscape:flex-1 min-h-0 tablet-landscape:min-w-0 bg-black" style={{ touchAction: "none" }} onPointerUp={handlePreviewTap}>
            <video
              ref={livePreviewRef}
              muted
              playsInline
              className="absolute inset-0 w-full h-full object-cover"
            />

            {/* Tap-to-follow ring: tracks across the preview as the player moves */}
            {autoFollowEnabled && lockedDisplayTarget && (
              <div
                className="absolute pointer-events-none z-20 flex flex-col items-center gap-1"
                style={{
                  left: `${lockedDisplayTarget.leftPct}%`,
                  top:  `${lockedDisplayTarget.topPct}%`,
                  transform: "translate(-50%, -50%)",
                }}
              >
                <div className={`w-24 h-24 rounded-full border-[3px] ring-2 shadow-lg ${lockLost ? "border-white/50 ring-white/20" : "border-primary animate-pulse ring-white/40"}`} />
                <span className={`text-[10px] font-bold rounded-full px-2 py-0.5 whitespace-nowrap backdrop-blur-sm ${lockLost ? "text-white bg-black/70" : "text-primary bg-black/70"}`}>
                  {lockLost ? "Lost lock — tap to re-lock" : "Locked"}
                </span>
              </div>
            )}

            {/* Instruction shown before user taps a player */}
            {autoFollowEnabled && !lockedDisplayTarget && (
              <div className="absolute inset-x-0 bottom-20 flex justify-center pointer-events-none z-20 tablet-landscape:bottom-4">
                <span className="text-xs font-semibold text-white bg-black/65 rounded-full px-4 py-2 backdrop-blur-sm">
                  Tap your player to lock focus
                </span>
              </div>
            )}

            {showRotateTip && (
              <div className="absolute inset-x-3 top-3 z-10 flex items-center justify-between gap-3 rounded-lg bg-black/70 px-3 py-2 text-white backdrop-blur-sm tablet-landscape:hidden">
                <span className="text-xs font-medium">
                  {canvasRef.current && canvasRef.current.width < canvasRef.current.height
                    ? "Heads up: this clip started in portrait, so it's locked to a portrait frame — rotating now won't make it fill the screen. Stop and restart in landscape if you want a full-screen video."
                    : "Tip: rotate your phone to landscape so this video fills the screen when you watch it back."}
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

            <div className="absolute top-0 left-0 right-0 flex items-start justify-between gap-2 p-3">
              <div className="flex flex-col gap-2">
                <span className="flex items-center gap-2 text-sm font-semibold text-white bg-black/50 rounded-full px-3 py-1 backdrop-blur-sm">
                  <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse shrink-0" />
                  {formatMs(elapsedMs)}
                  {recordedSegments.length > 0 && (
                    <span className="text-primary text-xs font-bold tabular-nums">H{recordedSegments.length + 1}</span>
                  )}
                </span>
                {isLive && liveCode && (
                  <div className="flex flex-col gap-1 rounded-lg bg-black/50 px-3 py-2 backdrop-blur-sm text-white max-w-[70vw]">
                    <span className="flex items-center gap-2 text-xs font-semibold">
                      <Radio className="w-3 h-3" /> LIVE
                      <span className="flex items-center gap-1 text-white/70"><Users className="w-3 h-3" /> {viewerCount}</span>
                    </span>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono bg-white/10 rounded px-2 py-0.5">{liveCode}</span>
                      <Button variant="ghost" size="sm" className="h-6 px-2 text-white hover:bg-white/20" onClick={shareWatchLink}>
                        <Share2 className="w-3 h-3 mr-1" /> Invite
                      </Button>
                    </div>
                    {liveQuality && liveQuality.index > 0 && (
                      <span className="flex items-center gap-1 text-[10px] font-medium text-amber-300">
                        <Gauge className="w-3 h-3 shrink-0" />
                        Auto quality: {liveQuality.label} — keeping the stream smooth
                      </span>
                    )}
                  </div>
                )}
              </div>

              <div className="flex flex-col items-end gap-2">
                  {canSwitchCamera && canCycleLens && (
                    <Button variant="secondary" size="sm" className="bg-black/50 text-white hover:bg-black/70 backdrop-blur-sm border-0" onClick={cycleLens}>
                      <Aperture className="w-4 h-4 mr-1" />
                      {lensLabel ? `Lens ${lensLabel}` : "Lens"}
                    </Button>
                  )}
                  {canSwitchCamera && isPremium && (
                    <Button
                      variant="secondary"
                      size="sm"
                      className={`bg-black/50 backdrop-blur-sm border-0 ${autoFollowEnabled ? "text-primary ring-1 ring-primary/60 hover:bg-black/70" : "text-white hover:bg-black/70"}`}
                      onClick={toggleAutoFollow}
                      disabled={isTrackingLoading}
                    >
                      {isTrackingLoading
                        ? <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                        : <Crosshair className={`w-4 h-4 mr-1 ${isTracking ? "animate-pulse" : ""}`} />}
                      {isTrackingLoading ? "Loading…" : autoFollowEnabled ? (isTracking ? "Tracking" : "Searching…") : "Auto-Follow"}
                    </Button>
                  )}
                  {canSwitchCamera && isPremium && autoFollowEnabled && (
                    <Button
                      variant="secondary"
                      size="sm"
                      className={`bg-black/50 backdrop-blur-sm border-0 hover:bg-black/70 ${courtViewSet ? "text-green-400 ring-1 ring-green-400/50" : "text-white"}`}
                      onClick={saveCourtView}
                    >
                      <Home className="w-4 h-4 mr-1" />
                      {courtViewSet ? "Court ✓" : "Set Court"}
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
            </div>

            {/* Audience-view PIP: shows the outgoing stream with object-contain
                (the same framing viewers see) so the broadcaster knows exactly
                how their shot is cropped on the other side. */}
            {isLive && showAudiencePip && (
              <div className="absolute bottom-16 right-3 z-20 flex flex-col gap-0.5">
                <div className="flex items-center justify-between px-1">
                  <span className="text-[10px] font-bold text-white/70 uppercase tracking-widest">Audience view</span>
                  <button
                    type="button"
                    onClick={() => setShowAudiencePip(false)}
                    className="text-white/50 hover:text-white/90 text-base leading-none px-1"
                    aria-label="Hide audience view"
                  >✕</button>
                </div>
                <div className="w-32 aspect-video rounded-md overflow-hidden border border-white/20 bg-black shadow-lg">
                  <video
                    ref={audiencePreviewRef}
                    muted
                    playsInline
                    autoPlay
                    className="w-full h-full object-contain"
                  />
                </div>
              </div>
            )}

            {isLive && !showAudiencePip && (
              <button
                type="button"
                onClick={() => setShowAudiencePip(true)}
                className="absolute bottom-16 right-3 z-20 text-[10px] font-semibold text-white/60 bg-black/50 rounded px-2 py-1 backdrop-blur-sm hover:text-white/90"
              >
                Audience view
              </button>
            )}

            {/* Quick stats overlay — compact per-player totals visible during recording */}
            {showQuickStats && selectedPlayerIds.length > 0 && (
              <div className="absolute top-3 left-3 z-20 bg-black/80 backdrop-blur-sm rounded-xl p-2.5 text-white min-w-[170px] max-w-[220px]">
                <div className="flex items-center justify-between mb-1.5">
                  <p className="text-[9px] font-bold uppercase tracking-widest text-white/50">Live Stats</p>
                  <button
                    type="button"
                    onClick={() => setShowQuickStats(false)}
                    className="text-white/40 hover:text-white/80 text-xs leading-none ml-2"
                    aria-label="Close stats"
                  >✕</button>
                </div>
                {selectedPlayerIds.map(pid => {
                  const player = players?.find(p => p.id === pid);
                  const s = stats[pid];
                  if (!player || !s) return null;
                  const pts = s.ftMade + 2 * s.twoMade + 3 * s.threeMade;
                  return (
                    <div key={pid} className="flex items-center gap-2 py-1 border-b border-white/10 last:border-0">
                      <span className="text-xs font-semibold flex-1 truncate">{player.name}</span>
                      <span className="text-primary font-bold text-sm tabular-nums">{pts}<span className="text-[10px] font-normal text-white/40">p</span></span>
                      <span className="text-[10px] text-white/55 tabular-nums">{s.rebounds}r {s.assists}a {s.steals}s</span>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="absolute bottom-0 left-0 right-0 flex flex-wrap items-center justify-center gap-2 p-3">
              {isRecordingPaused ? (
                <Button
                  variant="secondary"
                  className="bg-green-600/90 text-white hover:bg-green-700 border-0 font-bold"
                  onClick={resumeRecording}
                >
                  <Play className="w-4 h-4 mr-2" /> Resume
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  className="bg-amber-500/80 text-white hover:bg-amber-600 border-0 font-semibold"
                  onClick={pauseRecording}
                >
                  <Pause className="w-4 h-4 mr-2" /> Pause
                </Button>
              )}
              <Button variant="destructive" onClick={stopRecording}>
                <Square className="w-4 h-4 mr-2" /> Stop
              </Button>
              <Button
                variant="secondary"
                className="bg-amber-700/80 text-white hover:bg-amber-800 border-0 font-semibold"
                onClick={splitRecording}
                disabled={isRecordingPaused}
                title="Save this half and immediately start recording the next one"
              >
                <Circle className="w-3.5 h-3.5 mr-1.5 text-amber-300" />
                {recordedSegments.length === 0 ? "Start 2nd Half" : `Start Half ${recordedSegments.length + 2}`}
              </Button>
              <Button
                variant="secondary"
                className={micMuted
                  ? "bg-red-600 text-white hover:bg-red-700 border-0 font-bold"
                  : "bg-black/50 text-white hover:bg-black/70 backdrop-blur-sm border-0"}
                onClick={toggleMic}
              >
                {micMuted ? <MicOff className="w-4 h-4 mr-2" /> : <Mic className="w-4 h-4 mr-2" />}
                {micMuted ? "Mic Off" : "Mic"}
              </Button>
              {!isLive && !isReconnectingLive && (
                <>
                  {liveCode && (
                    <Button variant="secondary" className="bg-black/50 text-white hover:bg-black/70 backdrop-blur-sm border-0" onClick={shareWatchLink}>
                      <Share2 className="w-4 h-4 mr-2" /> Share Link
                    </Button>
                  )}
                  <Button variant="secondary" className="bg-black/50 text-white hover:bg-black/70 backdrop-blur-sm border-0" onClick={goLive} disabled={isStartingLive}>
                    {isStartingLive ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Radio className="w-4 h-4 mr-2 text-red-500" />}
                    Go Live
                  </Button>
                </>
              )}
              {(isLive || isReconnectingLive) && (
                <Button variant="secondary" className="bg-black/50 text-white hover:bg-black/70 backdrop-blur-sm border-0" onClick={stopGoingLive}>
                  <Radio className="w-4 h-4 mr-2 text-red-500 animate-pulse" /> End Live
                </Button>
              )}
              {selectedPlayerIds.length > 0 && (
                <Button
                  variant="secondary"
                  className={showQuickStats
                    ? "bg-primary/20 text-primary hover:bg-primary/30 border border-primary/40"
                    : "bg-black/50 text-white hover:bg-black/70 backdrop-blur-sm border-0"}
                  onClick={() => setShowQuickStats(prev => !prev)}
                >
                  <BarChart2 className="w-4 h-4 mr-2" />
                  Stats
                </Button>
              )}
            </div>
          </div>

          <div className="flex-[2] md:flex-1 min-h-0 tablet-landscape:min-w-0 tablet-landscape:w-[35%] tablet-landscape:flex-none tablet-landscape-lg:w-[300px] overflow-y-auto bg-background p-3 space-y-4 tablet-landscape-lg:p-2.5 tablet-landscape-lg:space-y-3">
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

            {shotPrompt && (
              <div className="rounded-xl border border-primary/40 bg-primary/5 px-4 py-3 space-y-2 animate-in slide-in-from-top-2 duration-200">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <span className="text-sm font-bold uppercase tracking-wide text-primary">🏀 Shot detected — {shotPrompt.playerName}</span>
                    {!isPro && shotPrompt.usageIndex > 0 && (
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        {shotPrompt.usageIndex >= FREE_TASTE_LIMIT
                          ? `Last free detection this session — upgrade for unlimited`
                          : `${shotPrompt.usageIndex} of ${FREE_TASTE_LIMIT} free detections`}
                      </p>
                    )}
                  </div>
                  <button onClick={() => setShotPrompt(null)} className="text-muted-foreground hover:text-foreground text-lg leading-none px-1 shrink-0">✕</button>
                </div>
                <div className="grid grid-cols-4 gap-2">
                  <Button size="sm" className="bg-green-600 hover:bg-green-500 text-white font-bold text-xs flex flex-col h-12 gap-0.5 leading-none" onClick={() => logShotFromPrompt('twoMade')}>
                    <Check className="w-3.5 h-3.5" /><span>2PT</span>
                  </Button>
                  <Button size="sm" className="bg-green-600 hover:bg-green-500 text-white font-bold text-xs flex flex-col h-12 gap-0.5 leading-none" onClick={() => logShotFromPrompt('threeMade')}>
                    <Check className="w-3.5 h-3.5" /><span>3PT</span>
                  </Button>
                  <Button size="sm" className="bg-red-600 hover:bg-red-500 text-white font-bold text-xs flex flex-col h-12 gap-0.5 leading-none" onClick={() => logShotFromPrompt('twoAttempted')}>
                    <X className="w-3.5 h-3.5" /><span>2 Miss</span>
                  </Button>
                  <Button size="sm" className="bg-red-600 hover:bg-red-500 text-white font-bold text-xs flex flex-col h-12 gap-0.5 leading-none" onClick={() => logShotFromPrompt('threeAttempted')}>
                    <X className="w-3.5 h-3.5" /><span>3 Miss</span>
                  </Button>
                </div>
              </div>
            )}

            {showShotUpgradeNudge && !shotPrompt && (
              <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 px-4 py-3 space-y-2 animate-in slide-in-from-top-2 duration-200">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-bold text-amber-500">🔒 AI Shot Detection — Upgrade to Pro</p>
                    <p className="text-xs text-muted-foreground mt-0.5">You've used your {FREE_TASTE_LIMIT} free detections this session. Pro unlocks unlimited AI shot detection, auto-follow tracking, highlight reels, and live streaming.</p>
                  </div>
                  <button onClick={() => setShowShotUpgradeNudge(false)} className="text-muted-foreground hover:text-foreground text-lg leading-none px-1 shrink-0">✕</button>
                </div>
                <Button size="sm" className="w-full" onClick={() => navigate("/billing")}>Upgrade to Pro →</Button>
              </div>
            )}

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
  const misses = attempt - made;
  return (
    <div className="flex flex-col border rounded-lg overflow-hidden bg-muted/20">
      <div className="bg-muted text-center py-1 text-xs font-bold tracking-widest text-muted-foreground">{label}</div>
      <div className="flex-1 flex flex-col items-center justify-center p-2 gap-1 tablet-landscape-lg:p-1.5">
        <div className="font-mono text-xl font-bold tracking-tighter tablet-landscape-lg:text-base">
          <span className="text-primary">{made}</span><span className="text-muted-foreground/50">/</span><span>{attempt}</span>
        </div>
      </div>
      <div className="grid grid-cols-2 divide-x divide-black/20 border-t">
        <Button
          variant="ghost"
          className="rounded-none h-14 tablet-landscape-lg:h-10 min-w-0 flex flex-col items-center justify-center gap-0.5 bg-green-600 text-white hover:bg-green-500 active:bg-green-700"
          onClick={onMake}
          onContextMenu={(e) => { e.preventDefault(); onUndoMake(); }}
        >
          <Check className="w-4 h-4 tablet-landscape-lg:w-3.5 tablet-landscape-lg:h-3.5 shrink-0" />
          <span className="text-[9px] font-bold leading-none whitespace-nowrap">MAKE</span>
        </Button>
        <Button
          variant="ghost"
          className="rounded-none h-14 tablet-landscape-lg:h-10 min-w-0 flex flex-col items-center justify-center gap-0.5 bg-red-600 text-white hover:bg-red-500 active:bg-red-700"
          onClick={onMiss}
          onContextMenu={(e) => { e.preventDefault(); onUndoMiss(); }}
        >
          <X className="w-4 h-4 tablet-landscape-lg:w-3.5 tablet-landscape-lg:h-3.5 shrink-0" />
          <span className="text-[9px] font-bold leading-none whitespace-nowrap">MISS</span>
        </Button>
      </div>
      {(made > 0 || misses > 0) && (
        <div className="grid grid-cols-2 divide-x divide-border border-t bg-muted/40">
          <Button
            variant="ghost"
            className="rounded-none h-7 tablet-landscape-lg:h-6 min-w-0 text-[10px] font-semibold text-muted-foreground hover:text-green-400 hover:bg-green-950/40 disabled:opacity-30 disabled:pointer-events-none px-1"
            onClick={onUndoMake}
            disabled={made <= 0}
            title="Undo last make"
          >
            −make
          </Button>
          <Button
            variant="ghost"
            className="rounded-none h-7 tablet-landscape-lg:h-6 min-w-0 text-[10px] font-semibold text-muted-foreground hover:text-red-400 hover:bg-red-950/40 disabled:opacity-30 disabled:pointer-events-none px-1"
            onClick={onUndoMiss}
            disabled={misses <= 0}
            title="Undo last miss"
          >
            −miss
          </Button>
        </div>
      )}
    </div>
  );
}

function ScoreControl({ label, score, onAdd, accent }: { label: string; score: number; onAdd: (n: number) => void; accent?: boolean }) {
  // Unlike the other in-game controls, this scoreboard is deliberately made
  // BIGGER (not smaller) on larger tablets: it's what gets read at a glance
  // while live-streaming and manually calling the score for viewers, so
  // legibility matters more here than reclaiming screen space.
  //
  // Now that the score boxes are stacked vertically (one per row) in the
  // tablet-landscape panel, each box has the full column width — enough room
  // to bring back a visible −1 correction button without squeezing the +1/+2/+3
  // targets.  The −1 button is styled ghost/muted so it reads as secondary to
  // the add buttons, making it clear it's a correction, not a scoring action.
  return (
    <div className={`flex-1 min-w-0 flex items-center gap-1.5 tablet-landscape-lg:gap-2 rounded-lg border px-2 py-1.5 tablet-landscape-lg:px-3 tablet-landscape-lg:py-2 ${accent ? "bg-primary/5 border-primary/20" : "bg-muted/20"}`}>
      <div className="min-w-0">
        <div className="text-[10px] tablet-landscape-lg:text-sm font-bold uppercase tracking-wide truncate text-muted-foreground leading-none">{label}</div>
        <div className={`font-mono font-bold text-2xl tablet-landscape-lg:text-5xl leading-tight ${accent ? "text-primary" : ""}`}>{score}</div>
      </div>
      <div className="flex items-center gap-1 tablet-landscape-lg:gap-1.5 ml-auto shrink-0">
        <Button
          variant="ghost"
          size="sm"
          className="h-9 w-9 p-0 text-sm font-bold text-muted-foreground border border-dashed border-muted-foreground/30 hover:text-destructive hover:border-destructive/40"
          onClick={() => onAdd(-1)}
          title="Subtract 1 (correct a mistake)"
        >
          −1
        </Button>
        <Button
          variant="secondary"
          size="sm"
          className="h-11 w-11 p-0 text-base font-bold"
          onClick={() => onAdd(1)}
        >
          +1
        </Button>
        <Button variant="secondary" size="sm" className="h-11 w-11 p-0 text-base font-bold" onClick={() => onAdd(2)}>+2</Button>
        <Button variant="secondary" size="sm" className="h-11 w-11 p-0 text-base font-bold" onClick={() => onAdd(3)}>+3</Button>
      </div>
    </div>
  );
}

function SingleStatCounter({ label, value, onInc, onDec }: any) {
  return (
    <div className="flex flex-col border rounded-lg overflow-hidden bg-muted/20">
      <div className="bg-muted text-center py-1 text-xs font-bold tracking-widest text-muted-foreground">{label}</div>
      <div className="flex-1 flex items-center justify-center p-2 tablet-landscape-lg:p-1">
        <div className="font-mono text-2xl tablet-landscape-lg:text-lg font-bold">{value}</div>
      </div>
      <div className="grid grid-cols-2 divide-x border-t">
        <Button variant="ghost" className="rounded-none h-12 tablet-landscape-lg:h-9 active:bg-muted" onClick={onDec}>-</Button>
        <Button variant="ghost" className="rounded-none h-12 tablet-landscape-lg:h-9 active:bg-muted" onClick={onInc}>+</Button>
      </div>
    </div>
  );
}
