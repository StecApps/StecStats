import React, { useState, useRef, useEffect, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  saveDraft,
  clearDraft,
  resolveDraft,
  queueGame,
  checkConnectivity,
  generateClientId,
  type ScorekeeperDraft,
} from '@/lib/offlineQueue';
import { useAutosaveDraft } from '@/lib/useAutosaveDraft';

export const PENDING_UPLOAD_KEY = 'stec:pending-mobile-upload';
export type PendingUpload = {
  uris: string[];
  teamId: number;
  teamName: string;
  opponent: string;
  date: string;
  teamScore: number;
  opponentScore: number;
  stats: Record<number, StatLine>;
  events: GameEvent[];
  savedAt: string;
};
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  FlatList,
  Alert,
  ActivityIndicator,
  Platform,
  useWindowDimensions,
  Modal,
  Animated,
  Share,
  PermissionsAndroid,
  ToastAndroid,
} from 'react-native';
import { useAuth } from '@clerk/expo';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { showNoVideoAlert } from '@/lib/noVideoAlert';
import { uploadVideoFile, UPLOAD_CANCELLED_MSG } from '@/lib/uploadVideoFile';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useListPlayers, useCreateGame, useRequestUploadUrl } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { tekoStyle } from '@/lib/tekoStyle';
import { CameraView, useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSharedValue, runOnJS } from 'react-native-reanimated';
// react-native-webrtc is a native module — not available in Expo Go.
// Require it dynamically so the app degrades to score-only live stream
// instead of crashing on the module-not-found error.
let RTCPeerConnection: any = null;
let RTCIceCandidate: any = null;
let RTCSessionDescription: any = null;
let mediaDevices: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const rn = require('react-native-webrtc');
  RTCPeerConnection = rn.RTCPeerConnection;
  RTCIceCandidate = rn.RTCIceCandidate;
  RTCSessionDescription = rn.RTCSessionDescription;
  mediaDevices = rn.mediaDevices;
} catch {
  // Expo Go — WebRTC unavailable; live video will fall back to score-only
}
import { saveGame, type StatLine, type GameEvent } from '@/lib/saveGame';
import { makeUploadStallHandler } from '@/lib/uploadStallAlert';
import { concatSegmentsWithTimeout } from '@/lib/concatSegmentsWithTimeout';
import { fetchIceServers } from '@/lib/fetchIceServers';
import { drainPendingViewers } from '@/lib/drainPendingViewers';
import {
  BITRATE_LADDER,
  initialBitrateState,
  nextBitrateState,
} from '@/lib/adaptiveBitrate';

const defaultLine = (): StatLine => ({
  ftMade: 0, ftAttempted: 0,
  twoMade: 0, twoAttempted: 0,
  threeMade: 0, threeAttempted: 0,
  assists: 0, rebounds: 0,
  steals: 0, turnovers: 0, blocks: 0,
});

function calcPoints(line: StatLine): number {
  return line.twoMade * 2 + line.threeMade * 3 + line.ftMade;
}

function formatTime(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}


export default function ScorekeeperScreen() {
  const {
    opponent = 'Opponent',
    teamId = '0',
    teamName = 'Your Team',
    date = new Date().toISOString().split('T')[0],
    recordVideo: recordVideoParam = 'false',
  } = useLocalSearchParams<{ opponent: string; teamId: string; teamName: string; date: string; recordVideo: string }>();

  const recordVideo = recordVideoParam === 'true';

  const { getToken } = useAuth();

  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const qc = useQueryClient();
  const createGame = useCreateGame();
  const requestUploadUrlMutation = useRequestUploadUrl();

  const { data: players, isLoading: playersLoading, refetch: refetchPlayers } = useListPlayers({
    // Poll every 30 s so a player rename done in another tab or device is picked
    // up without requiring the coach to reload or leave the screen.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: { refetchInterval: 30_000 } as any,
  });

  // Refetch the player list whenever this screen comes into focus so that
  // a player added in the Roster screen is visible immediately at game start.
  useFocusEffect(
    useCallback(() => {
      refetchPlayers();
    }, [refetchPlayers]),
  );

  // ── Draft recovery on mount ────────────────────────────────────────────────
  // If a previous session was interrupted (crash, force-quit), offer to restore.
  // resolveDraft() is the single source of truth for match eligibility —
  // it loads, checks teamId/opponent/date, and clears stale drafts internally.
  useEffect(() => {
    (async () => {
      const draft = await resolveDraft(
        Number(teamId),
        opponent as string,
        date as string,
      );
      if (!draft) return;
      const { Alert: RNAlert } = await import('react-native');
      RNAlert.alert(
        'Resume Game?',
        'It looks like this game was interrupted. Restore your stats from the last autosave?',
        [
          {
            text: 'Discard',
            style: 'destructive',
            onPress: () => clearDraft(),
          },
          {
            text: 'Restore',
            style: 'default',
            onPress: () => {
              setStats(draft.stats);
              setEvents(draft.events);
              setOpponentScore(draft.opponentScore);
              setTeamScoreAdj(draft.teamScoreAdj);
              setHalf(draft.half);
              setSeconds(draft.seconds);
            },
          },
        ],
      );
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [selectedPlayerId, setSelectedPlayerId] = useState<number | null>(null);
  const [stats, setStats] = useState<Record<number, StatLine>>({});
  const [events, setEvents] = useState<GameEvent[]>([]);

  // ── Offline / connectivity state ───────────────────────────────────────────
  const [isOnline, setIsOnline] = useState(true);
  // Mirror in a ref so async callbacks read the latest value without stale closures.
  const isOnlineRef = useRef(true);
  const connectivityIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [opponentScore, setOpponentScore] = useState(0);
  // Manual quick-score adjustment for our team (on top of auto-calculated player stats).
  // Coaches can tap +1/+2/+3 in the camera overlay to credit untracked points quickly.
  const [teamScoreAdj, setTeamScoreAdj] = useState(0);
  // Camera section dimensions — used to compute the scale factor that makes
  // the CameraView fill (cover) its container regardless of the camera's
  // native preview aspect ratio.
  const [cameraContainerSize, setCameraContainerSize] = useState({ w: 0, h: 0 });
  const [half, setHalf] = useState<1 | 2>(1);
  const [seconds, setSeconds] = useState(0);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const uploadXhrRef = useRef<XMLHttpRequest | null>(null);
  // Per-attempt cancel token. Each handleSave() creates a fresh object; async stages
  // close over their own token so a subsequent attempt's reset can't un-cancel an
  // in-flight attempt.
  const uploadAttemptRef = useRef<{ cancelled: boolean } | null>(null);
  // When the concat-merge times out and the coach taps "Retry merge", we can't
  // call handleSave() directly because its closure still sees saving===true.
  // Instead, onRetry stores the already-uploaded paths here and calls
  // setSaving(false); a useEffect below detects the transition and re-runs
  // just the concat + doSaveGame step — skipping the upload entirely.
  const pendingMergeRetryRef = useRef<string[] | null>(null);
  // Guards against stacking multiple stall alerts if progress stays frozen.
  const stallAlertActiveRef = useRef(false);
  // Latches to true after the coach taps 'Keep waiting' once.  Prevents a
  // second identical alert from firing if the upload stays frozen — the coach
  // has already been warned and has chosen to wait, so re-alerting every 45 s
  // only increases anxiety without giving them new information.
  const stallFiredOnceRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startRef = useRef<number>(0);
  // Broadcaster-side signaling WebSocket — kept open for the duration of a live session
  const liveWsRef = useRef<WebSocket | null>(null);
  // WebRTC broadcaster: one RTCPeerConnection per connected viewer (keyed by viewerId)
  const webrtcPeersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  // Per-viewer ICE restart attempt counters — reset when a viewer's connection recovers
  const iceRestartCountRef = useRef<Map<string, number>>(new Map());
  // Per-viewer disconnect-state watchdog timers (preemptive ICE restart after 10 s)
  const disconnectWatchdogRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Per-viewer adaptive-bitrate poll intervals — cleared when a peer is torn down
  const bitrateIntervalRef = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());
  // Viewer IDs for which createPeerForViewer is currently in-flight.
  // Prevents duplicate concurrent peer-creation attempts for the same viewer
  // (e.g. two rapid new-viewer messages after a WS reconnect storm).
  const peerCreationInFlightRef = useRef<Set<string>>(new Set());
  // Live camera MediaStream used for WebRTC — opened via mediaDevices.getUserMedia
  const webrtcStreamRef = useRef<any>(null);
  // Viewer IDs that sent new-viewer while getUserMedia was still in-flight
  // (e.g. immediately after a camera flip). Drained once the stream is ready.
  const pendingViewerIdsRef = useRef<string[]>([]);
  const liveWsReconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set to true before an intentional close (stopLiveBroadcast) so ws.onclose
  // does not schedule a reconnect. Reset to false whenever a new connection is
  // opened so unintentional drops still auto-reconnect normally.
  const liveWsIntentionalCloseRef = useRef(false);
  // Tracks whether getUserMedia resolved to a failure before the signaling
  // WebSocket opened. ws.onopen reads this ref so it always sends the
  // authoritative videoMode — not the optimistic permission-based guess.
  // Reset at the top of the WebRTC stream effect whenever isLive/liveCode
  // change so a fresh broadcast starts in the 'pending' (optimistic) state.
  const webrtcCameraFailedRef = useRef(false);
  // Mirrors the latest team/opponent scores so reconnect callbacks don't
  // depend on derived consts that are declared later in the function body.
  const latestScoresRef = useRef({ teamScore: 0, opponentScore: 0 });

  // Camera / recording state
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [micPermission, requestMicPermission] = useMicrophonePermissions();
  const cameraRef = useRef<CameraView>(null);
  const [isRecording, setIsRecording] = useState(false);
  const recordingPromiseRef = useRef<Promise<{ uri: string } | undefined> | null>(null);
  // All clip URIs collected so far (one per camera-flip segment + final clip).
  const recordedUrisRef = useRef<string[]>([]);
  // Generation counter: incremented on each new startRecording call so the
  // finally block of an older recording doesn't clobber a newer one's state.
  const recordingGenerationRef = useRef(0);
  const recordingStartedRef = useRef(false);
  const cameraReadyRef = useRef(false);
  const pendingRecordRef = useRef(false);

  // Camera UI state
  const [cameraFacing, setCameraFacing] = useState<'back' | 'front'>('back');
  const [previewVisible, setPreviewVisible] = useState(true);
  const [micMuted, setMicMuted] = useState(false);
  // null = follow device rotation; true/false = locked to landscape/portrait
  const [layoutLandscape, setLayoutLandscape] = useState<boolean | null>(null);

  // ── Camera zoom (pinch-to-zoom) ───────────────────────────────────────────
  // cameraZoom is 0-1 passed to CameraView's zoom prop.
  // pinchBaseZoom is the committed zoom at the START of each pinch gesture.
  const [cameraZoom, setCameraZoom] = useState(0);
  const [zoomBadgeVisible, setZoomBadgeVisible] = useState(false);
  const zoomBadgeOpacity = useRef(new Animated.Value(0)).current;
  const zoomHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pinchBaseZoom = useSharedValue(0);

  function showZoomBadge(zoom: number) {
    setCameraZoom(Math.min(1, Math.max(0, zoom)));
    setZoomBadgeVisible(true);
    zoomBadgeOpacity.stopAnimation();
    Animated.timing(zoomBadgeOpacity, { toValue: 1, duration: 120, useNativeDriver: true }).start();
    if (zoomHideTimer.current) clearTimeout(zoomHideTimer.current);
    zoomHideTimer.current = setTimeout(() => {
      Animated.timing(zoomBadgeOpacity, { toValue: 0, duration: 400, useNativeDriver: true }).start(() => setZoomBadgeVisible(false));
    }, 1400);
  }

  const pinchGesture = Gesture.Pinch()
    .onStart(() => {
      pinchBaseZoom.value = cameraZoom;
    })
    .onUpdate((e) => {
      // Map pinch scale to a zoom delta: scale 1.0 = no change, 2.0 = +0.4, 0.5 = -0.2
      const newZoom = Math.min(1, Math.max(0, pinchBaseZoom.value + (e.scale - 1) * 0.45));
      runOnJS(showZoomBadge)(newZoom);
    });

  // Live broadcast state
  const [liveCode, setLiveCode] = useState<string | null>(null);
  const [isLive, setIsLive] = useState(false);
  const [liveLoading, setLiveLoading] = useState(false);
  const [showGoLiveSheet, setShowGoLiveSheet] = useState(false);
  // Pulsing animation for the LIVE badge
  const livePulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!isLive) { livePulse.setValue(1); return; }
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(livePulse, { toValue: 0.25, duration: 700, useNativeDriver: true }),
        Animated.timing(livePulse, { toValue: 1,    duration: 700, useNativeDriver: true }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [isLive]);

  // ─── Live broadcast helpers ────────────────────────────────────────────────
  function watchUrl(code: string): string {
    const domain = process.env.EXPO_PUBLIC_DOMAIN;
    return domain ? `https://${domain}/watch/${code}` : `/watch/${code}`;
  }

  async function startLiveBroadcast() {
    if (liveLoading || isLive) return;

    // Android 12+ (API 31+) requires BLUETOOTH_CONNECT at runtime for WebRTC
    // to route audio through a connected Bluetooth headset. Request it before
    // opening the broadcast. On denial the broadcast still starts but audio
    // falls back to the device speaker.
    if (Platform.OS === 'android' && (Platform.Version as number) >= 31) {
      try {
        const btResult = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          {
            title: 'Bluetooth Headset',
            message:
              'Allow Hoops Stats to use your Bluetooth headset for broadcast audio.',
            buttonPositive: 'Allow',
            buttonNegative: 'Deny',
          },
        );
        if (btResult !== PermissionsAndroid.RESULTS.GRANTED) {
          ToastAndroid.show(
            'Bluetooth permission denied — broadcast audio will use the speaker.',
            ToastAndroid.LONG,
          );
        }
      } catch {
        // Permission API unavailable on this device — proceed without headset routing
      }
    }

    setLiveLoading(true);
    try {
      const token = await getToken();
      const res = await fetch(`${API_BASE}/api/live/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ opponent: opponent as string, teamName: teamName as string }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if ((body as any)?.code === 'UPGRADE_REQUIRED') {
          Alert.alert('Pro Feature', 'Live streaming requires a Pro subscription.');
        } else {
          Alert.alert('Go Live failed', (body as any)?.error ?? `Server error (${res.status})`);
        }
        return;
      }
      const { code } = await res.json();
      setLiveCode(code);
      setIsLive(true);
      setShowGoLiveSheet(true);
      connectBroadcasterWs(code, teamScore, opponentScore);
    } catch (err: any) {
      Alert.alert('Go Live failed', err?.message ?? 'Could not start broadcast');
    } finally {
      setLiveLoading(false);
    }
  }

  // ─── WebRTC broadcaster helpers ─────────────────────────────────────────────
  // Tear down a single viewer's peer and all associated timers/counters.
  // Safe to call even if the viewer was never fully set up.
  function teardownPeerForViewer(viewerId: string) {
    const interval = bitrateIntervalRef.current.get(viewerId);
    if (interval) { clearInterval(interval); bitrateIntervalRef.current.delete(viewerId); }
    const watchdog = disconnectWatchdogRef.current.get(viewerId);
    if (watchdog) { clearTimeout(watchdog); disconnectWatchdogRef.current.delete(viewerId); }
    iceRestartCountRef.current.delete(viewerId);
    const pc = webrtcPeersRef.current.get(viewerId);
    if (pc) { try { pc.close(); } catch {} webrtcPeersRef.current.delete(viewerId); }
  }

  function closeAllWebRtcPeers() {
    for (const timer of disconnectWatchdogRef.current.values()) {
      clearTimeout(timer);
    }
    disconnectWatchdogRef.current.clear();
    for (const interval of bitrateIntervalRef.current.values()) {
      clearInterval(interval);
    }
    bitrateIntervalRef.current.clear();
    iceRestartCountRef.current.clear();
    // Clear in-flight creation guards so a fresh broadcast doesn't block on
    // stale viewer IDs from the previous session.
    peerCreationInFlightRef.current.clear();
    for (const pc of webrtcPeersRef.current.values()) {
      try { pc.close(); } catch {}
    }
    webrtcPeersRef.current.clear();
  }

  function stopWebRtcStream() {
    if (webrtcStreamRef.current) {
      webrtcStreamRef.current.getTracks?.().forEach((t: any) => t.stop());
      webrtcStreamRef.current = null;
    }
  }

  async function createPeerForViewer(viewerId: string, code: string) {
    if (!RTCPeerConnection) return; // native module not available (Expo Go)
    // Guard against concurrent duplicate calls for the same viewer (e.g. two
    // rapid new-viewer messages arriving during a WS reconnect storm).  If a
    // creation is already in-flight for this viewer, the second call would
    // tear down the peer the first is building, leaving both in a broken state.
    if (peerCreationInFlightRef.current.has(viewerId)) {
      console.log(`[WebRTC] createPeerForViewer: already in-flight for ${viewerId} — skipping`);
      return;
    }
    peerCreationInFlightRef.current.add(viewerId);
    try {
    // Close and fully clean up any prior peer for this viewer before replacing it.
    // Without this, the old peer's callbacks keep firing and can send conflicting
    // ICE-restart offers or peer-connection-failed after the viewer has reconnected.
    teardownPeerForViewer(viewerId);
    const iceServers = await fetchIceServers(API_BASE);
    const pc = new RTCPeerConnection({ iceServers });
    webrtcPeersRef.current.set(viewerId, pc);

    // Add all camera tracks to this viewer's peer connection
    if (webrtcStreamRef.current) {
      for (const track of webrtcStreamRef.current.getTracks()) {
        pc.addTrack(track, webrtcStreamRef.current);
      }
    }

    // Relay locally gathered ICE candidates to this viewer
    pc.onicecandidate = (event: any) => {
      if (event.candidate) {
        broadcastWsSend({
          type: 'ice-candidate',
          code,
          targetId: viewerId,
          candidate: event.candidate.toJSON?.() ?? event.candidate,
        });
      }
    };

    // Helper: attempt an ICE restart for this viewer, capped at 3 tries.
    // Prevents duplicate in-flight restarts via an async flag.
    let iceRestartPending = false;
    async function attemptIceRestart() {
      if (iceRestartPending) return;
      const attempts = (iceRestartCountRef.current.get(viewerId) ?? 0) + 1;
      if (attempts > 3) {
        console.warn(`[WebRTC] ICE restart cap reached for viewer ${viewerId} — sending peer-connection-failed`);
        broadcastWsSend({ type: 'peer-connection-failed', code, targetId: viewerId });
        webrtcPeersRef.current.delete(viewerId);
        // Clean up the adaptive-bitrate interval and disconnect watchdog for
        // this viewer so they don't keep firing after the peer is gone.
        const interval = bitrateIntervalRef.current.get(viewerId);
        if (interval) { clearInterval(interval); bitrateIntervalRef.current.delete(viewerId); }
        const watchdog = disconnectWatchdogRef.current.get(viewerId);
        if (watchdog) { clearTimeout(watchdog); disconnectWatchdogRef.current.delete(viewerId); }
        iceRestartCountRef.current.delete(viewerId);
        try { pc.close(); } catch {}
        return;
      }
      iceRestartCountRef.current.set(viewerId, attempts);
      iceRestartPending = true;
      try {
        const offer = await pc.createOffer({ iceRestart: true } as any);
        await pc.setLocalDescription(offer as any);
        broadcastWsSend({ type: 'offer', code, targetId: viewerId, sdp: (offer as any).sdp, renegotiate: true });
        console.log(`[WebRTC] ICE restart offer sent (attempt ${attempts}) for viewer ${viewerId}`);
      } catch (err) {
        console.warn(`[WebRTC] ICE restart failed for viewer ${viewerId}:`, err);
      } finally {
        iceRestartPending = false;
      }
    }

    (pc as any).onconnectionstatechange = () => {
      // Guard: ignore callbacks from a stale peer that has already been replaced
      // or torn down (e.g. after a viewer reconnect issued a fresh offer).
      if (webrtcPeersRef.current.get(viewerId) !== pc) return;
      const state = (pc as any).connectionState;
      if (state === 'failed') {
        // Cancel any pending disconnect watchdog — connection already hard-failed.
        const existing = disconnectWatchdogRef.current.get(viewerId);
        if (existing) { clearTimeout(existing); disconnectWatchdogRef.current.delete(viewerId); }
        attemptIceRestart();
      } else if (state === 'disconnected') {
        // Arm a 10 s watchdog: if the connection doesn't self-heal, fire a
        // preemptive ICE restart before it reaches 'failed'.
        if (!disconnectWatchdogRef.current.has(viewerId)) {
          const timer = setTimeout(() => {
            disconnectWatchdogRef.current.delete(viewerId);
            if ((pc as any).connectionState === 'disconnected') {
              console.log(`[WebRTC] Disconnect watchdog fired for viewer ${viewerId} — preemptive ICE restart`);
              attemptIceRestart();
            }
          }, 10_000);
          disconnectWatchdogRef.current.set(viewerId, timer);
        }
      } else if (state === 'connected') {
        // Connection recovered — cancel watchdog and reset the restart counter.
        const existing = disconnectWatchdogRef.current.get(viewerId);
        if (existing) { clearTimeout(existing); disconnectWatchdogRef.current.delete(viewerId); }
        iceRestartCountRef.current.delete(viewerId);
      }
    };

    // ── Adaptive bitrate ──────────────────────────────────────────────────────
    // Poll getStats() every 5 s and step maxBitrate through a 3-rung quality
    // ladder based on remote RTT and packet-loss fraction.
    // Hysteresis: 2 consecutive bad polls → step down; 4 clean polls → step up.
    // State machine logic lives in lib/adaptiveBitrate.ts (unit-tested there).
    let abrState = initialBitrateState();

    const bitrateInterval = setInterval(async () => {
      if ((pc as any).connectionState !== 'connected') return;
      try {
        const stats: RTCStatsReport = await pc.getStats();
        let rtt = 0;
        let fractionLost = 0;
        stats.forEach((report: any) => {
          if (report.type === 'remote-inbound-rtp' && report.kind === 'video') {
            if (typeof report.roundTripTime === 'number') rtt = report.roundTripTime;
            if (typeof report.fractionLost === 'number') fractionLost = report.fractionLost;
          }
        });

        const { state: nextState, rungChanged } = nextBitrateState(abrState, { rtt, fractionLost });
        abrState = nextState;

        if (rungChanged) {
          const sender = pc.getSenders().find((s: any) => s.track?.kind === 'video');
          if (sender) {
            const params = sender.getParameters();
            if (params.encodings && params.encodings.length > 0) {
              params.encodings[0].maxBitrate = BITRATE_LADDER[abrState.rung];
              await sender.setParameters(params);
              console.log(`[WebRTC] Bitrate → rung ${abrState.rung} (${BITRATE_LADDER[abrState.rung]} bps) for viewer ${viewerId}`);
            }
          }
        }
      } catch {
        // getStats() or setParameters() can throw if the connection is being torn down — ignore
      }
    }, 5_000);
    bitrateIntervalRef.current.set(viewerId, bitrateInterval);

    // Create the initial offer and send it to the viewer
    const offer = await pc.createOffer({} as any);
    await pc.setLocalDescription(offer as any);
    broadcastWsSend({ type: 'offer', code, targetId: viewerId, sdp: (offer as any).sdp });
    } finally {
      // Always remove the in-flight guard so a future new-viewer for this
      // viewer can create a fresh peer (e.g. after the viewer rejoins).
      peerCreationInFlightRef.current.delete(viewerId);
    }
  }

  async function stopLiveBroadcast(code: string) {
    // Dismiss the go-live sheet first so it doesn't linger open while the
    // stop sequence runs (handles the case where handleSave calls us directly
    // without the sheet's own dismiss-then-stop button handler).
    setShowGoLiveSheet(false);
    // Mark as intentional BEFORE closing so ws.onclose does not schedule a
    // reconnect — even if the stop-API call below is slow or hangs.
    liveWsIntentionalCloseRef.current = true;
    // Tear down WebRTC peers and camera stream before closing the WS.
    closeAllWebRtcPeers();
    stopWebRtcStream();
    // Close broadcaster WS first so viewers get the broadcaster-left signal
    if (liveWsReconnectRef.current) {
      clearTimeout(liveWsReconnectRef.current);
      liveWsReconnectRef.current = null;
    }
    if (liveWsRef.current) {
      liveWsRef.current.close();
      liveWsRef.current = null;
    }
    try {
      // 5-second hard cap — getToken() or fetch can hang if the network is flaky.
      // This is best-effort; the WS is already closed so viewers are notified
      // regardless of whether the HTTP call succeeds.
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 5000);
      try {
        const token = await Promise.race([
          getToken(),
          new Promise<null>((_, rej) => setTimeout(() => rej(new Error('getToken timeout')), 4000)),
        ]);
        await fetch(`${API_BASE}/api/live/${encodeURIComponent(code)}/stop`, {
          method: 'POST',
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          signal: ac.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // best-effort — game save must not be blocked by a slow or failed stop call
    }
    setIsLive(false);
    setLiveCode(null);
  }

  // ─── Broadcaster WebSocket helpers ───────────────────────────────────────
  // Map StatLine field names to the readable labels shown in the viewer ticker.
  const STAT_LABELS: Record<string, string> = {
    twoMade: '2PT', threeMade: '3PT', ftMade: 'FT',
    rebounds: 'REB', assists: 'AST', steals: 'STL',
    blocks: 'BLK', turnovers: 'TO',
  };

  function broadcastWsSend(payload: object) {
    const ws = liveWsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  function connectBroadcasterWs(code: string, initTeamScore: number, initOppScore: number) {
    if (liveWsRef.current) {
      liveWsRef.current.close();
      liveWsRef.current = null;
    }
    // Opening a new connection — this is intentional, so clear the intentional-close
    // flag so that an unintentional drop later can trigger auto-reconnect.
    liveWsIntentionalCloseRef.current = false;
    // Build wss:// URL from the same base the HTTP calls use
    const wsBase = API_BASE
      ? API_BASE.replace(/^https?:\/\//, (m) => (m.startsWith('https') ? 'wss://' : 'ws://'))
      : `${typeof window !== 'undefined' && window.location?.protocol === 'https:' ? 'wss' : 'ws'}://localhost`;
    const ws = new WebSocket(`${wsBase}/api/live/ws`);
    liveWsRef.current = ws;

    ws.onopen = () => {
      // Use the authoritative camera mode: if getUserMedia already rejected
      // before this socket opened (webrtcCameraFailedRef is true), announce
      // score-only immediately so viewers never wait on the offer watchdog.
      // Otherwise fall back to the permission-based optimistic value.
      const cameraFailed = webrtcCameraFailedRef.current;
      // RTCPeerConnection is null when running in Expo Go (native module unavailable)
      const webrtcSupported = RTCPeerConnection !== null;
      const hasVideo = webrtcSupported && !cameraFailed && !!(cameraPermission?.granted);
      const videoMode = hasVideo ? 'webrtc' : 'none';
      ws.send(JSON.stringify({
        type: 'join-broadcaster',
        code,
        teamScore: initTeamScore,
        opponentScore: initOppScore,
        hasVideo,
        videoMode,
      }));
    };

    ws.onmessage = async (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data as string);
        if (msg.type === 'new-viewer') {
          if (webrtcStreamRef.current) {
            // Stream is ready — offer immediately.
            await createPeerForViewer(msg.viewerId, code);
          } else {
            // getUserMedia is still in-flight (e.g. after a camera flip).
            // Queue this viewer; drainPendingViewers will offer them once
            // the stream resolves, rather than leaving them on the watchdog.
            pendingViewerIdsRef.current.push(msg.viewerId);
          }
        } else if (msg.type === 'answer') {
          // Viewer responded with an SDP answer
          const pc = webrtcPeersRef.current.get(msg.viewerId);
          if (pc) {
            await pc.setRemoteDescription(
              new RTCSessionDescription({ type: 'answer', sdp: msg.sdp })
            );
          }
        } else if (msg.type === 'ice-candidate') {
          // Viewer sent an ICE candidate
          const pc = webrtcPeersRef.current.get(msg.viewerId);
          if (pc && msg.candidate) {
            await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
          }
        } else if (msg.type === 'viewer-left') {
          // Viewer disconnected — tear down their peer and all associated timers.
          teardownPeerForViewer(msg.viewerId);
        }
      } catch { /* signaling error */ }
    };

    ws.onclose = () => {
      if (liveWsRef.current !== ws) return; // already replaced by a newer connection
      if (liveWsIntentionalCloseRef.current) return; // stopLiveBroadcast — do not reconnect
      liveWsRef.current = null;
      // Auto-reconnect while we're still live (api-server may have restarted)
      liveWsReconnectRef.current = setTimeout(() => {
        liveWsReconnectRef.current = null;
        // Read current liveCode from state — only reconnect if still live.
        // Use latestScoresRef so this closure doesn't depend on derived consts
        // (teamScore / opponentScore) that are declared later in the render body.
        setLiveCode((current) => {
          if (current) {
            const { teamScore: ts, opponentScore: os } = latestScoresRef.current;
            connectBroadcasterWs(current, ts, os);
          }
          return current;
        });
      }, 3000);
    };

    ws.onerror = () => ws.close();
  }

  function toggleCameraFacing() {
    if (!isRecording) {
      // Not recording — switch immediately
      setCameraFacing((f) => (f === 'back' ? 'front' : 'back'));
      cameraReadyRef.current = false;
      return;
    }
    // Recording — confirm before stopping the clip and switching
    Alert.alert(
      'Switch Camera?',
      'Current clip will be saved as Part 1. Recording will resume from the new camera.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Switch',
          style: 'default',
          onPress: async () => {
            // Stop the active recording and capture the URI
            cameraRef.current?.stopRecording();
            if (recordingPromiseRef.current) {
              try {
                const result = await recordingPromiseRef.current;
                if (result?.uri) recordedUrisRef.current.push(result.uri);
              } catch { /* recording stopped cleanly */ }
            }
            // Reset so startRecording can be called again
            recordingStartedRef.current = false;
            recordingPromiseRef.current = null;
            // Switch camera; onCameraReady will restart recording via pendingRecordRef
            cameraReadyRef.current = false;
            pendingRecordRef.current = true;
            setCameraFacing((f) => (f === 'back' ? 'front' : 'back'));
          },
        },
      ],
    );
  }

  function togglePreview() {
    setPreviewVisible((v) => !v);
  }

  useEffect(() => {
    if (!recordVideo) return;
    (async () => {
      if (!cameraPermission?.granted) await requestCameraPermission();
      if (!micPermission?.granted) await requestMicPermission();
    })();
  }, [recordVideo]);

  useEffect(() => {
    if (!players) return;
    setStats((prev) => {
      const next = { ...prev };
      for (const p of players as any[]) {
        if (!next[p.id]) next[p.id] = defaultLine();
      }
      return next;
    });
    if (!selectedPlayerId && (players as any[]).length > 0) {
      setSelectedPlayerId((players as any[])[0].id);
    }
  }, [players]);

  useEffect(() => {
    if (running) {
      timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [running]);

  async function startRecording() {
    if (!cameraRef.current || recordingStartedRef.current) return;
    if (!cameraPermission?.granted || !micPermission?.granted) return;
    recordingStartedRef.current = true;
    const myGen = ++recordingGenerationRef.current;
    setIsRecording(true);
    try {
      recordingPromiseRef.current = cameraRef.current.recordAsync({ mute: micMuted } as any) as Promise<{ uri: string } | undefined>;
      await recordingPromiseRef.current;
      // URI is captured by whoever calls stopRecording (handleSave or toggleCameraFacing)
    } catch (err: any) {
      if (myGen === recordingGenerationRef.current) {
        // Error on this specific session (not superseded by a camera flip)
        recordingStartedRef.current = false;
        recordingPromiseRef.current = null;
      }
      console.warn('Camera recording ended:', err?.message);
    } finally {
      // Only update isRecording if a newer recording session hasn't already taken over
      if (myGen === recordingGenerationRef.current) {
        setIsRecording(false);
      }
    }
  }

  function onCameraReady() {
    cameraReadyRef.current = true;
    if (pendingRecordRef.current && !recordingStartedRef.current) {
      pendingRecordRef.current = false;
      startRecording();
    }
  }

  function handleStartStop() {
    if (!running) {
      if (seconds === 0) startRef.current = Date.now();
      setRunning(true);
      if (recordVideo && !recordingStartedRef.current) {
        if (cameraReadyRef.current) {
          startRecording();
        } else {
          pendingRecordRef.current = true;
        }
      }
    } else {
      setRunning(false);
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  }

  function nowMs() {
    return running ? Date.now() - startRef.current : seconds * 1000;
  }

  // ─── Shooting stat handlers ────────────────────────────────────────────────
  function handleShoot(
    action: 'make' | 'miss' | 'undoMake' | 'undoMiss',
    madeKey: keyof StatLine,
    attKey: keyof StatLine,
    statField: string,
  ) {
    if (!selectedPlayerId) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const ts = nowMs();
    setStats((prev) => {
      const line = prev[selectedPlayerId] ?? defaultLine();
      const made = line[madeKey] as number;
      const att = line[attKey] as number;
      let nextMade = made;
      let nextAtt = att;
      if (action === 'make') { nextMade = made + 1; nextAtt = att + 1; }
      else if (action === 'miss') { nextAtt = att + 1; }
      else if (action === 'undoMake') { nextMade = Math.max(0, made - 1); nextAtt = Math.max(0, att - 1); }
      else if (action === 'undoMiss') {
        // Only undo a miss if there are more attempts than makes
        if (att > made) nextAtt = att - 1;
      }
      // Safety clamp: made must never exceed attempted
      nextMade = Math.min(nextMade, nextAtt);
      return { ...prev, [selectedPlayerId]: { ...line, [madeKey]: nextMade, [attKey]: nextAtt } };
    });
    if (action === 'make') {
      setEvents((prev) => [...prev, { playerId: selectedPlayerId, statField, delta: 1, videoTimestampMs: ts }]);
      if (isLive && liveCode) {
        const playerName = (players as any[])?.find((p: any) => p.id === selectedPlayerId)?.name ?? 'Player';
        broadcastWsSend({ type: 'stat-event', code: liveCode, playerName, label: STAT_LABELS[statField] ?? statField });
      }
    } else if (action === 'miss') {
      // Log the *attempted* field so the lowlight generator can identify missed shots.
      // It pairs each attempted event with nearby make events; unmatched ones = true misses.
      setEvents((prev) => [...prev, { playerId: selectedPlayerId, statField: attKey as string, delta: 1, videoTimestampMs: ts }]);
    }
  }

  // ─── Counting stat handlers ────────────────────────────────────────────────
  function handleCount(field: keyof StatLine, delta: 1 | -1) {
    if (!selectedPlayerId) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const ts = nowMs();
    setStats((prev) => {
      const line = prev[selectedPlayerId] ?? defaultLine();
      const current = line[field] as number;
      return { ...prev, [selectedPlayerId]: { ...line, [field]: Math.max(0, current + delta) } };
    });
    if (delta === 1) {
      setEvents((prev) => [...prev, { playerId: selectedPlayerId, statField: field as string, delta: 1, videoTimestampMs: ts }]);
      if (isLive && liveCode) {
        const playerName = (players as any[])?.find((p: any) => p.id === selectedPlayerId)?.name ?? 'Player';
        broadcastWsSend({ type: 'stat-event', code: liveCode, playerName, label: STAT_LABELS[field as string] ?? String(field) });
      }
    }
  }

  const teamScore = Object.values(stats).reduce((sum, line) => sum + calcPoints(line), 0) + teamScoreAdj;

  // ─── WebRTC camera stream — opened when live, closed when done ──────────────
  useEffect(() => {
    // Reset the camera-failed flag whenever broadcast state changes so that a
    // fresh go-live starts optimistically ('pending'), not stuck on a prior failure.
    webrtcCameraFailedRef.current = false;

    if (!isLive || !liveCode || !cameraPermission?.granted) {
      closeAllWebRtcPeers();
      stopWebRtcStream();
      return;
    }
    // Open the camera stream for WebRTC broadcast.
    // expo-camera (CameraView) and react-native-webrtc both access the camera —
    // iOS 16+ supports simultaneous sessions cleanly.
    if (!mediaDevices) return; // native module not available (Expo Go)
    let cancelled = false;
    (async () => {
      try {
        const stream = await mediaDevices.getUserMedia({
          video: { facingMode: cameraFacing === 'back' ? 'environment' : 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: true,
        });
        if (!cancelled) {
          webrtcStreamRef.current = stream;

          // Watch for the camera track ending unexpectedly (iOS thermal throttle,
          // AVFoundation session conflict with expo-camera, or system preemption).
          // Switch viewers to score-only mode so the broadcast can continue
          // without the frozen camera preview requiring a force-quit.
          const videoTrack = stream.getVideoTracks?.()[0];
          if (videoTrack) {
            (videoTrack as any).addEventListener?.('ended', () => {
              if (cancelled) return;
              console.warn('[WebRTC] Camera track ended unexpectedly — switching to score-only');
              webrtcCameraFailedRef.current = true;
              // Close all peer connections — they can no longer send video.
              closeAllWebRtcPeers();
              stopWebRtcStream();
              // Notify server/viewers that video is gone so they drop to scoreboard.
              broadcastWsSend({
                type: 'join-broadcaster',
                code: liveCode,
                hasVideo: false,
                videoMode: 'none',
              });
            });
          }

          // Offer any viewers who arrived while the stream was opening.
          drainPendingViewers(
            pendingViewerIdsRef.current,
            stream,
            (id) => createPeerForViewer(id, liveCode!),
          );
        }
      } catch (e) {
        console.warn('[WebRTC] getUserMedia failed — viewers will see score-only:', e);
        if (!cancelled) {
          // Mark the failure so ws.onopen sends the authoritative score-only
          // mode when the socket hasn't opened yet (race: getUserMedia rejected
          // before onopen fired). If the socket is already open, broadcastWsSend
          // immediately notifies the server to push session-mode to viewers.
          webrtcCameraFailedRef.current = true;
          broadcastWsSend({
            type: 'join-broadcaster',
            code: liveCode,
            hasVideo: false,
            videoMode: 'none',
          });
        }
      }
    })();
    return () => {
      cancelled = true;
      pendingViewerIdsRef.current = [];
      closeAllWebRtcPeers();
      stopWebRtcStream();
    };
  }, [isLive, liveCode, cameraPermission?.granted, cameraFacing]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Live scoreboard push — fires whenever score changes while broadcasting ──
  useEffect(() => {
    latestScoresRef.current = { teamScore, opponentScore };
    if (!isLive || !liveCode) return;
    broadcastWsSend({ type: 'scoreboard', code: liveCode, teamScore, opponentScore });
  }, [teamScore, opponentScore, isLive, liveCode]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Cleanup broadcaster WS on unmount ───────────────────────────────────
  useEffect(() => {
    return () => {
      if (liveWsReconnectRef.current) clearTimeout(liveWsReconnectRef.current);
      liveWsRef.current?.close();
    };
  }, []);

  // ─── Deferred merge retry ─────────────────────────────────────────────────
  // When the concat-merge times out the coach taps "Retry merge". We can't
  // call handleSave() from inside the alert callback because the closure still
  // sees saving===true and the guard returns immediately.  Instead, onRetry
  // stores paths in pendingMergeRetryRef and calls setSaving(false).  This
  // effect fires once React has flushed the state update and re-runs only
  // the concat + doSaveGame step (the clips are already uploaded).
  useEffect(() => {
    if (saving || !pendingMergeRetryRef.current) return;
    const paths = pendingMergeRetryRef.current;
    pendingMergeRetryRef.current = null;
    doMergeAndSave(paths);
  }, [saving]); // eslint-disable-line react-hooks/exhaustive-deps

  const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
    ? `https://${process.env.EXPO_PUBLIC_DOMAIN}`
    : '';

  // ── Connectivity polling ───────────────────────────────────────────────────
  // Probe the API's health endpoint every 5 s. On transition online→offline or
  // offline→online, update state and (on recovery) kick off queued-game sync.
  useEffect(() => {
    let mounted = true;

    async function probe() {
      const online = await checkConnectivity(API_BASE);
      if (!mounted) return;
      const wasOnline = isOnlineRef.current;
      isOnlineRef.current = online;
      setIsOnline(online);
      // Sync is handled app-level via useOfflineQueueSync in _layout.tsx
    }

    probe(); // immediate first check
    connectivityIntervalRef.current = setInterval(probe, 5_000);
    return () => {
      mounted = false;
      if (connectivityIntervalRef.current) {
        clearInterval(connectivityIntervalRef.current);
        connectivityIntervalRef.current = null;
      }
    };
  }, [API_BASE]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Draft autosave ─────────────────────────────────────────────────────────
  // Debounced: waits 2 s after the last change before writing to AsyncStorage,
  // so rapid stat taps don't hammer the storage layer.
  useAutosaveDraft({
    teamId: Number(teamId),
    teamName: teamName as string,
    opponent: opponent as string,
    date: date as string,
    stats,
    events,
    opponentScore,
    teamScoreAdj,
    half,
    seconds,
    saving,
  });

  // ─── Guarded back navigation ──────────────────────────────────────────────
  // Intercepts the close/back button when a save is in progress so the coach
  // can't accidentally lose all stats by navigating away mid-upload.
  // The stats + video URIs are written to AsyncStorage BEFORE any upload bytes
  // are sent, so "Leave anyway" is safe — the Games tab will offer recovery.
  function handleClose() {
    if (!saving) {
      router.back();
      return;
    }
    const isUploading = uploadProgress !== null;
    Alert.alert(
      isUploading ? 'Upload still running' : 'Save in progress',
      isUploading
        ? 'Your stats are saved on this device. Leaving will cancel the video — you can save stats-only now, or retry the upload from the Games screen.'
        : 'Finishing up — hang on a moment. If you must leave, your stats are saved on this device and can be recovered from the Games screen.',
      [
        { text: 'Stay', style: 'cancel' },
        ...(isUploading ? [{
          text: 'Save stats only',
          style: 'default' as const,
          onPress: () => {
            if (uploadAttemptRef.current) uploadAttemptRef.current.cancelled = true;
            uploadXhrRef.current?.abort();
            uploadXhrRef.current = null;
            setUploadProgress(null);
            setSaving(false);
            doSaveGame(null);
          },
        }] : []),
        {
          text: 'Leave anyway',
          style: 'destructive',
          onPress: () => {
            if (uploadAttemptRef.current) uploadAttemptRef.current.cancelled = true;
            uploadXhrRef.current?.abort();
            uploadXhrRef.current = null;
            router.back();
          },
        },
      ],
    );
  }

  // Retry only the concat + save step when the coach taps "Retry merge" after a
  // timeout. Called by the useEffect above once saving===false has been flushed.
  // The clips are already uploaded so we skip straight to concat-segments.
  async function doMergeAndSave(segmentPaths: string[]) {
    const freshToken = { cancelled: false };
    uploadAttemptRef.current = freshToken;
    setSaving(true);
    setUploadProgress(92);
    try {
      const authToken = await getToken();
      const result = await concatSegmentsWithTimeout({
        apiBase: API_BASE,
        token: authToken,
        segmentPaths,
        onRetry: () => {
          freshToken.cancelled = true;
          pendingMergeRetryRef.current = segmentPaths;
          setSaving(false);
        },
        onSaveWithoutVideo: () => {
          freshToken.cancelled = true;
          doSaveGame(null);
        },
      });
      if (result.timedOut) {
        setUploadProgress(null);
        return;
      }
      if (freshToken.cancelled) return;
      setUploadProgress(100);
      setUploadProgress(null);
      await doSaveGame(result.videoObjectPath);
    } catch (err: any) {
      setUploadProgress(null);
      Alert.alert('Video merge failed', err?.message ?? 'Could not merge clips. Save without video?', [
        { text: 'Cancel', style: 'cancel', onPress: () => setSaving(false) },
        { text: 'Save without video', onPress: () => doSaveGame(null) },
      ]);
    }
  }

  async function handleSave() {
    if (saving) return;
    if (!players || (players as any[]).length === 0) {
      Alert.alert('No players', 'Add players to your team before saving a game.');
      return;
    }
    // End any active broadcast before saving so viewers get the final score
    if (liveCode) {
      await stopLiveBroadcast(liveCode);
    }

    // ── Offline shortcut ───────────────────────────────────────────────────
    // When there's no network, skip video upload entirely and queue the game
    // locally.  Video requires a working upload connection so we offer
    // stats-only or cancellation.
    if (!isOnlineRef.current) {
      if (recordVideo && recordedUrisRef.current.length > 0) {
        Alert.alert(
          'No connection',
          'Video upload requires a connection. Save stats now without video, or wait until you\'re back online.',
          [
            { text: 'Wait', style: 'cancel' },
            {
              text: 'Save stats only',
              style: 'default',
              onPress: () => { setSaving(true); doSaveGame(null); },
            },
          ],
        );
      } else {
        setSaving(true);
        doSaveGame(null);
      }
      return;
    }

    // Create a fresh per-attempt token. The async stages below close over this
    // object, so a subsequent attempt's fresh token can never un-cancel us.
    const attemptToken = { cancelled: false };
    uploadAttemptRef.current = attemptToken;
    setSaving(true);
    try {
      let videoObjectPath: string | null = null;
      if (recordVideo) {
        // Stop the active recording and capture its URI into the array
        if (recordingStartedRef.current) {
          cameraRef.current?.stopRecording();
          setIsRecording(false);
          if (recordingPromiseRef.current) {
            try {
              const result = await recordingPromiseRef.current;
              if (result?.uri) recordedUrisRef.current.push(result.uri);
            } catch { /* already stopped cleanly */ }
          }
        }

        if (recordedUrisRef.current.length === 0) {
          showNoVideoAlert(recordingStartedRef.current, setSaving, doSaveGame);
          return;
        }

        try {
          const uris = recordedUrisRef.current;
          const uploadedPaths: string[] = [];

          // Persist video URIs + game data now — before any bytes are sent.
          // If the upload is cancelled or the app is killed, the games tab can
          // offer recovery so nothing is permanently lost.
          await AsyncStorage.setItem(PENDING_UPLOAD_KEY, JSON.stringify({
            uris,
            teamId: Number(teamId),
            teamName: teamName as string,
            opponent: opponent as string,
            date: date as string,
            teamScore,
            opponentScore,
            stats,
            events,
            savedAt: new Date().toISOString(),
          } satisfies PendingUpload)).catch(() => {/* non-fatal */});

          setUploadProgress(0);
          stallAlertActiveRef.current = false;
          stallFiredOnceRef.current = false;

          // Stall callback: called by uploadVideoFile when real XHR progress
          // hasn't advanced for ~45 s. Shows a non-blocking alert so the coach
          // can decide to keep waiting, save without video, or cancel the upload.
          // Guards against duplicate alerts if progress stays frozen:
          //   • stallAlertActiveRef prevents re-entry while the alert is visible.
          //   • stallFiredOnceRef prevents a second alert after 'Keep waiting' —
          //     the coach has already been warned; re-alerting every 45 s only
          //     increases anxiety without providing new information.
          const onUploadStall = makeUploadStallHandler({
            stallAlertActiveRef,
            stallFiredOnceRef,
            attemptToken,
            uploadXhrRef,
            setUploadProgress,
            setSaving,
            doSaveGame,
            handleCancelUpload,
          });

          for (let i = 0; i < uris.length; i++) {
            // Scale overall progress: each clip gets an equal slice of 0–90 %
            const segStart = Math.round((i / uris.length) * 90);
            const segEnd   = Math.round(((i + 1) / uris.length) * 90);
            const p = await uploadVideoFile(
              uris[i],
              (body) => requestUploadUrlMutation.mutateAsync({ data: body }),
              (pct) => setUploadProgress(segStart + Math.round((pct / 100) * (segEnd - segStart))),
              uploadXhrRef,
              attemptToken,
              onUploadStall,
            );
            if (attemptToken.cancelled) return;
            uploadedPaths.push(p);
          }

          if (attemptToken.cancelled) return;

          if (uploadedPaths.length === 1) {
            videoObjectPath = uploadedPaths[0];
            setUploadProgress(100);
          } else {
            // Multiple clips from camera flips — concat server-side.
            // concatSegmentsWithTimeout applies a 60-second AbortController and
            // surfaces "Retry merge" / "Save without video" if the server hangs.
            setUploadProgress(92);
            const token = await getToken();
            const concatResult = await concatSegmentsWithTimeout({
              apiBase: API_BASE,
              token,
              segmentPaths: uploadedPaths,
              onRetry: () => {
                // Can't call handleSave() here — the closure sees saving===true
                // and returns immediately.  Store the paths so the useEffect
                // above can re-run just the concat + doSaveGame once React
                // flushes the saving===false state update.
                attemptToken.cancelled = true;
                pendingMergeRetryRef.current = uploadedPaths;
                setSaving(false);
              },
              onSaveWithoutVideo: () => {
                attemptToken.cancelled = true;
                doSaveGame(null);
              },
            });
            if (concatResult.timedOut) {
              setUploadProgress(null);
              return;
            }
            videoObjectPath = concatResult.videoObjectPath;
            setUploadProgress(100);
          }

          setUploadProgress(null);
          // Guard: if cancel was pressed just as the last upload finished, honour
          // the cancellation and let handleCancelUpload's alert drive next action.
          if (attemptToken.cancelled) return;
        } catch (uploadErr: any) {
          // Silently return if the coach deliberately cancelled — handleCancelUpload
          // already reset state and showed the "save without video" prompt.
          if (attemptToken.cancelled) return;
          setUploadProgress(null);
          Alert.alert(
            'Video upload failed',
            uploadErr?.message ?? 'Could not upload video. Save game without video?',
            [
              { text: 'Cancel', style: 'cancel', onPress: () => setSaving(false) },
              { text: 'Save without video', style: 'default', onPress: () => doSaveGame(null) },
            ],
          );
          return;
        }
      }
      await doSaveGame(videoObjectPath);
    } catch (err: any) {
      setUploadProgress(null);
      Alert.alert('Save failed', err?.message ?? 'Could not save game');
      setSaving(false);
    }
  }

  /**
   * Builds the QueuedGame payload from current state and persists it locally.
   * Accepts the `clientId` that was generated at the start of the save attempt
   * so that a retry after a dropped-response scenario can hit the server's
   * ON CONFLICT DO NOTHING path rather than creating a duplicate game.
   */
  async function queueCurrentGame(clientId: string): Promise<void> {
    const statLines = (players as any[]).map((p: any) => {
      const line = stats[p.id] ?? defaultLine();
      return { playerId: p.id, ...line };
    });
    const result = teamScore > opponentScore ? 'W' : 'L';
    // queueGame throws on AsyncStorage failure — let it propagate so the
    // caller can alert the coach instead of silently losing data.
    await queueGame({
      clientId,
      teamId: Number(teamId),
      opponent: opponent as string,
      date: date as string,
      result,
      teamScore,
      opponentScore,
      stats: statLines,
      events,
      queuedAt: new Date().toISOString(),
    });
    await clearDraft();
    await AsyncStorage.removeItem(PENDING_UPLOAD_KEY).catch(() => {});
  }

  function doSaveGame(videoObjectPath: string | null) {
    // Generate ONE stable ID for this entire save attempt.  The same ID is:
    //   • sent in the online POST body so the server stores it as client_game_id
    //   • used by onNetworkFailure when queuing locally after a dropped response
    //   • used by the offline-only path below
    // This ensures a retry of a queued game finds the already-created server row
    // via ON CONFLICT DO NOTHING instead of inserting a duplicate.
    const saveClientId = generateClientId();

    // ── Offline path: queue locally and navigate back ─────────────────────
    // Only available for stats-only saves (no video) — video upload requires
    // an active connection and is automatically skipped when offline.
    if (!isOnlineRef.current && !videoObjectPath) {
      return (async () => {
        try {
          await queueCurrentGame(saveClientId);
          Alert.alert(
            'Game saved locally',
            'Your stats are saved on this device and will sync automatically when your connection returns.',
            [{
              text: 'OK',
              onPress: () => router.replace('/(tabs)/games' as any),
            }],
          );
        } catch {
          Alert.alert('Save failed', 'Could not save game locally — storage may be full. Please try again.');
        } finally {
          setSaving(false);
        }
      })();
    }

    // ── Online path: save to server ────────────────────────────────────────
    return saveGame(videoObjectPath, {
      players: (players as any[]),
      stats,
      teamScore,
      opponentScore,
      teamId: Number(teamId),
      opponent: opponent as string,
      date: date as string,
      events,
      // Pass the stable ID so the server can store it and detect replays.
      clientId: saveClientId,
      createGameMutateAsync: (args) => createGame.mutateAsync(args as any),
      invalidateQueries: (opts) => qc.invalidateQueries(opts),
      routerReplace: async (path) => {
        // Clear the pending-upload marker and draft only after the game is confirmed saved.
        await AsyncStorage.removeItem(PENDING_UPLOAD_KEY).catch(() => {});
        await clearDraft();
        router.replace(path as any);
      },
      setSaving,
      // If the network drops between tapping "End Game" and the POST completing,
      // queue the game locally using the SAME clientId so the server-side
      // ON CONFLICT DO NOTHING deduplicates the replay if the row was already
      // committed before the response was lost.
      onNetworkFailure: async () => {
        try {
          await queueCurrentGame(saveClientId);
          Alert.alert(
            'Connection lost — game saved locally',
            'Stats are saved on this device and will sync automatically when your connection returns.',
            [{ text: 'OK', onPress: () => router.replace('/(tabs)/games' as any) }],
          );
        } catch {
          Alert.alert(
            'Save failed',
            'Connection lost and local storage failed. Please screenshot your stats and try again.',
          );
        }
      },
    });
  }

  function handleCancelUpload() {
    // Mark the current attempt's token first so every in-flight async stage sees
    // it — even if the XHR doesn't exist yet (fetch/presign phase). Because each
    // handleSave() captures its own token object by closure, a subsequent save
    // attempt's fresh token is unaffected by this mutation.
    if (uploadAttemptRef.current) uploadAttemptRef.current.cancelled = true;
    uploadXhrRef.current?.abort();
    uploadXhrRef.current = null;
    setUploadProgress(null);
    setSaving(false);
    Alert.alert(
      'Upload cancelled',
      'Your recording is still on this device. Retry the upload, or save your stats now without video.',
      [
        { text: 'Retry upload', style: 'default', onPress: handleSave },
        { text: 'Save without video', onPress: () => doSaveGame(null) },
        { text: 'Dismiss', style: 'cancel' },
      ],
    );
  }

  function confirmSave() {
    Alert.alert(
      'Save Game',
      `${teamName} ${teamScore} – ${opponentScore} ${opponent}. Save?`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Save', style: 'default', onPress: handleSave },
      ],
    );
  }

  const { width: sw, height: sh } = useWindowDimensions();
  const isLandscape = layoutLandscape !== null ? layoutLandscape : sw > sh;

  const styles = makeStyles(colors, insets, sw, sh, isLandscape);
  const cameraReady = recordVideo && cameraPermission?.granted && micPermission?.granted;
  const selectedLine = selectedPlayerId ? (stats[selectedPlayerId] ?? defaultLine()) : null;

  if (playersLoading) {
    return (
      <View style={[styles.root, styles.centered]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  // ── Shared: scoreboard rendered inside the camera section overlay ──
  const scoreboardOverlay = (
    <View style={styles.scoreOverlay}>
      <TouchableOpacity onPress={handleClose} style={styles.closeBtn}>
        <Ionicons name="chevron-down" size={22} color="rgba(255,255,255,0.85)" />
      </TouchableOpacity>
      <View style={styles.scoreboard}>
        {/* Our score — tap +1/+2/+3 to credit quick points not tracked to a player */}
        <View style={styles.scoreCol}>
          <Text style={styles.teamLabel} numberOfLines={1}>{teamName}</Text>
          <View style={styles.oppScoreRow}>
            <TouchableOpacity
              onPress={() => { setTeamScoreAdj((s) => (teamScore > 0 ? s - 1 : s)); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
              disabled={teamScore === 0}
              style={[styles.oppBtn, { opacity: teamScore === 0 ? 0.35 : 1 }]}
              hitSlop={{ top: 14, bottom: 14, left: 14, right: 8 }}
            >
              <Text style={styles.oppBtnText}>−</Text>
            </TouchableOpacity>
            <Text style={styles.scoreNum}>{teamScore}</Text>
            {([1, 2, 3] as const).map((pts) => (
              <TouchableOpacity
                key={pts}
                onPress={() => { setTeamScoreAdj((s) => s + pts); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
                style={styles.oppOverlayQuickBtn}
                hitSlop={{ top: 10, bottom: 10, left: 4, right: 4 }}
              >
                <Text style={styles.oppOverlayQuickBtnText}>+{pts}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Center: timer + half */}
        <View style={styles.scoreCenter}>
          <Text style={styles.timer}>{formatTime(seconds)}</Text>
          <TouchableOpacity
            onPress={handleStartStop}
            style={[styles.timerBtn, { backgroundColor: running ? 'rgba(255,255,255,0.18)' : colors.primary }]}
          >
            <Ionicons name={running ? 'pause' : 'play'} size={14} color="#fff" />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => { setHalf((h) => (h === 1 ? 2 : 1)); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
            style={styles.halfBtn}
          >
            <Text style={styles.halfText}>{half === 1 ? '1st' : '2nd'}</Text>
          </TouchableOpacity>
        </View>

        {/* Opponent score — display only in overlay; use the OPP bar below to score */}
        <View style={styles.scoreCol}>
          <Text style={styles.teamLabel} numberOfLines={1}>{opponent}</Text>
          <Text style={styles.scoreNum}>{opponentScore}</Text>
        </View>
      </View>
    </View>
  );

  // ── Shared: stat area ──
  // When the camera preview is filling the top half of the screen, we switch to
  // a compact layout so ALL stat tickers are visible without scrolling.
  const cameraCompact = recordVideo && previewVisible;

  const statArea = (
    <>
      {/* ── Offline banner ─────────────────────────────────────────────────── */}
      {!isOnline && (
        <View style={[styles.offlineBanner, { backgroundColor: '#78350f', borderBottomColor: '#92400e' }]}>
          <Ionicons name="cloud-offline-outline" size={14} color="#fde68a" />
          <Text style={styles.offlineBannerText}>Stats saving locally — will sync when connected</Text>
        </View>
      )}

      {/* ── Opponent score bar — shown only during recording; non-recording uses the compact header ── */}
      {recordVideo && <View style={[styles.oppBar, { backgroundColor: colors.card, borderBottomColor: colors.border }]}>
        <View style={styles.oppBarLeft}>
          <View style={[styles.oppBarTagPill, { backgroundColor: colors.primary + '1A' }]}>
            <Text style={[styles.oppBarTagText, { color: colors.primary }]}>OPP</Text>
          </View>
          <Text style={[styles.oppBarName, { color: colors.foreground }]} numberOfLines={1}>{opponent}</Text>
        </View>
        <View style={styles.oppBarRight}>
          <TouchableOpacity
            onPress={() => { setOpponentScore((s) => Math.max(0, s - 1)); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
            style={[styles.oppBtn, { backgroundColor: colors.muted }]}
            hitSlop={{ top: 14, bottom: 14, left: 14, right: 8 }}
          >
            <Text style={[styles.oppBtnText, { color: colors.foreground }]}>−</Text>
          </TouchableOpacity>
          <Text style={[styles.oppBarScore, { color: colors.foreground }]}>{opponentScore}</Text>
          {([1, 2, 3] as const).map((pts) => (
            <TouchableOpacity
              key={pts}
              onPress={() => { setOpponentScore((s) => s + pts); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
              style={[styles.oppQuickBtn, { backgroundColor: colors.primary + '20', borderColor: colors.primary + '50' }]}
              hitSlop={{ top: 10, bottom: 10, left: 4, right: 4 }}
            >
              <Text style={[styles.oppQuickBtnText, { color: colors.primary }]}>+{pts}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>}

      {/* Camera hidden badge — subtle reminder that recording is still running */}
      {recordVideo && !previewVisible && (
        <View style={[styles.cameraHiddenBadge, { backgroundColor: colors.muted, borderColor: colors.border }]}>
          <Ionicons name="videocam" size={11} color={colors.mutedForeground} />
          <Text style={[styles.cameraHiddenText, { color: colors.mutedForeground }]}>
            {isRecording ? 'Recording — camera hidden' : 'Camera hidden'}
          </Text>
        </View>
      )}

      {/* Player selector */}
      <View style={[styles.playerBar, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <FlatList
          horizontal
          data={players as any[]}
          keyExtractor={(p) => String(p.id)}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 12, gap: 8 }}
          renderItem={({ item: p }) => {
            const isSelected = selectedPlayerId === p.id;
            const pts = calcPoints(stats[p.id] ?? defaultLine());
            return (
              <TouchableOpacity
                onPress={() => setSelectedPlayerId(p.id)}
                activeOpacity={0.7}
                style={[
                  styles.playerChip,
                  {
                    backgroundColor: isSelected ? colors.primary : colors.muted,
                    borderColor: isSelected ? colors.primary : colors.border,
                  },
                ]}
              >
                <Text style={[styles.playerChipName, { color: isSelected ? '#fff' : colors.foreground }]} numberOfLines={1}>
                  {p.name.split(' ')[0]}
                </Text>
                <Text style={[styles.playerChipPts, { color: isSelected ? 'rgba(255,255,255,0.7)' : colors.mutedForeground }]}>
                  {pts}
                </Text>
              </TouchableOpacity>
            );
          }}
        />
      </View>

      {/* ── Stat area: compact flat layout when camera is live, scrollable cards otherwise ── */}
      {cameraCompact ? (
        /* ─── COMPACT MODE: all tickers fit on screen without scrolling ─── */
        <View style={styles.compactStatArea}>
          {!selectedPlayerId ? (
            <Text style={[styles.noPlayerText, { color: colors.mutedForeground }]}>
              Select a player above to track stats
            </Text>
          ) : (
            <>
              {/* Shared-row shooting grid: header / MAKE / MISS rows across all 3 stats */}
              <View style={styles.compactShootGrid}>
                {/* Header row — label + made/att count side by side */}
                <View style={styles.compactBtnRow}>
                  {([
                    { label: '2PT', madeKey: 'twoMade',   attKey: 'twoAttempted',   statField: 'twoMade' },
                    { label: '3PT', madeKey: 'threeMade', attKey: 'threeAttempted', statField: 'threeMade' },
                    { label: 'FT',  madeKey: 'ftMade',    attKey: 'ftAttempted',    statField: 'ftMade' },
                  ] as const).map((s) => {
                    const made = (selectedLine![s.madeKey as keyof StatLine] as number);
                    const att  = (selectedLine![s.attKey  as keyof StatLine] as number);
                    return (
                      <View key={s.label} style={styles.compactShootHeaderCell}>
                        <Text style={[styles.compactShootLabel, { color: colors.mutedForeground }]}>{s.label}</Text>
                        <Text style={[styles.compactShootCount, { color: colors.foreground }]}>{made}/{att}</Text>
                      </View>
                    );
                  })}
                </View>

                {/* MAKE row */}
                <View style={styles.compactBtnRow}>
                  {([
                    { label: '2PT', madeKey: 'twoMade',   attKey: 'twoAttempted',   statField: 'twoMade' },
                    { label: '3PT', madeKey: 'threeMade', attKey: 'threeAttempted', statField: 'threeMade' },
                    { label: 'FT',  madeKey: 'ftMade',    attKey: 'ftAttempted',    statField: 'ftMade' },
                  ] as const).map((s) => (
                    <TouchableOpacity
                      key={s.label}
                      onPress={() => handleShoot('make', s.madeKey as any, s.attKey as any, s.statField)}
                      style={[styles.compactMakeBtn, { backgroundColor: '#16a34a' }]}
                      activeOpacity={0.7}
                    >
                      <Ionicons name="checkmark" size={12} color="#fff" />
                      <Text style={styles.compactActionBtnText}>MAKE</Text>
                    </TouchableOpacity>
                  ))}
                </View>

                {/* MISS row */}
                <View style={styles.compactBtnRow}>
                  {([
                    { label: '2PT', madeKey: 'twoMade',   attKey: 'twoAttempted',   statField: 'twoMade' },
                    { label: '3PT', madeKey: 'threeMade', attKey: 'threeAttempted', statField: 'threeMade' },
                    { label: 'FT',  madeKey: 'ftMade',    attKey: 'ftAttempted',    statField: 'ftMade' },
                  ] as const).map((s) => (
                    <TouchableOpacity
                      key={s.label}
                      onPress={() => handleShoot('miss', s.madeKey as any, s.attKey as any, s.statField)}
                      style={[styles.compactMissBtn, { backgroundColor: colors.destructive }]}
                      activeOpacity={0.7}
                    >
                      <Ionicons name="close" size={12} color="#fff" />
                      <Text style={styles.compactActionBtnText}>MISS</Text>
                    </TouchableOpacity>
                  ))}
                </View>

                {/* Undo row — −Mk / −Ms per column */}
                <View style={styles.compactBtnRow}>
                  {([
                    { label: '2PT', madeKey: 'twoMade',   attKey: 'twoAttempted',   statField: 'twoMade' },
                    { label: '3PT', madeKey: 'threeMade', attKey: 'threeAttempted', statField: 'threeMade' },
                    { label: 'FT',  madeKey: 'ftMade',    attKey: 'ftAttempted',    statField: 'ftMade' },
                  ] as const).map((s) => {
                    const made = (selectedLine![s.madeKey as keyof StatLine] as number);
                    const att  = (selectedLine![s.attKey  as keyof StatLine] as number);
                    const hasMiss = att > made;
                    return (
                      <View key={s.label} style={styles.compactUndoCell}>
                        <TouchableOpacity
                          onPress={() => handleShoot('undoMake', s.madeKey as any, s.attKey as any, s.statField)}
                          disabled={made === 0}
                          activeOpacity={0.7}
                          style={[styles.compactUndoBtn, { borderColor: colors.border, opacity: made === 0 ? 0.3 : 1 }]}
                        >
                          <Text style={[styles.compactUndoBtnText, { color: colors.mutedForeground }]}>−Mk</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={() => handleShoot('undoMiss', s.madeKey as any, s.attKey as any, s.statField)}
                          disabled={!hasMiss}
                          activeOpacity={0.7}
                          style={[styles.compactUndoBtn, { borderColor: colors.border, opacity: hasMiss ? 1 : 0.3 }]}
                        >
                          <Text style={[styles.compactUndoBtnText, { color: colors.mutedForeground }]}>−Ms</Text>
                        </TouchableOpacity>
                      </View>
                    );
                  })}
                </View>
              </View>

              {/* Counting stats: single horizontal strip (no wrapping) */}
              <View style={styles.compactCountStrip}>
                {([
                  { label: 'REB', field: 'rebounds',  color: 'primary' },
                  { label: 'AST', field: 'assists',   color: 'primary' },
                  { label: 'STL', field: 'steals',    color: 'primary' },
                  { label: 'BLK', field: 'blocks',    color: 'primary' },
                  { label: 'TO',  field: 'turnovers', color: 'destructive' },
                ] as const).map((s) => {
                  const val = (selectedLine![s.field as keyof StatLine] as number);
                  const accent = s.color === 'destructive' ? colors.destructive : colors.primary;
                  return (
                    <View key={s.label} style={[styles.compactCountCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                      <Text style={[styles.compactCountLabel, { color: colors.mutedForeground }]}>{s.label}</Text>
                      <Text style={[styles.compactCountVal, { color: accent }]}>{val}</Text>
                      <View style={styles.compactCountBtns}>
                        <TouchableOpacity
                          onPress={() => handleCount(s.field as keyof StatLine, -1)}
                          disabled={val === 0}
                          activeOpacity={0.7}
                          style={[styles.compactCountBtn, { backgroundColor: colors.muted, opacity: val === 0 ? 0.3 : 1 }]}
                        >
                          <Text style={[styles.compactCountBtnTxt, { color: colors.mutedForeground }]}>−</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={() => handleCount(s.field as keyof StatLine, 1)}
                          activeOpacity={0.7}
                          style={[styles.compactCountBtn, { backgroundColor: accent + '20', borderColor: accent + '40', borderWidth: 1 }]}
                        >
                          <Text style={[styles.compactCountBtnTxt, { color: accent }]}>+</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  );
                })}
              </View>
            </>
          )}
        </View>
      ) : (
        /* ─── FULL MODE: scrollable tall cards (no camera taking space) ─── */
        <ScrollView style={styles.statScroll} contentContainerStyle={styles.statContent} showsVerticalScrollIndicator={false}>
          {!selectedPlayerId ? (
            <Text style={[styles.noPlayerText, { color: colors.mutedForeground }]}>Select a player above to track stats</Text>
          ) : (
            <>
              {/* ── Shooting stats ── */}
              <View style={styles.shootRow}>
                {([
                  { label: '2PT', madeKey: 'twoMade', attKey: 'twoAttempted', statField: 'twoMade' },
                  { label: '3PT', madeKey: 'threeMade', attKey: 'threeAttempted', statField: 'threeMade' },
                  { label: 'FT',  madeKey: 'ftMade',   attKey: 'ftAttempted',   statField: 'ftMade' },
                ] as const).map((s) => {
                  const line = selectedLine!;
                  const made = line[s.madeKey as keyof StatLine] as number;
                  const att  = line[s.attKey as keyof StatLine] as number;
                  const hasMiss = att > made;
                  return (
                    <View key={s.label} style={[styles.shootCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                      <Text style={[styles.shootLabel, { color: colors.mutedForeground }]}>{s.label}</Text>
                      <Text style={[styles.shootValue, { color: colors.foreground }]}>{made}/{att}</Text>
                      <TouchableOpacity
                        onPress={() => handleShoot('make', s.madeKey as any, s.attKey as any, s.statField)}
                        style={[styles.makeBtn, { backgroundColor: '#16a34a' }]}
                        activeOpacity={0.7}
                      >
                        <Ionicons name="checkmark" size={13} color="#fff" />
                        <Text style={styles.shootBtnText}>MAKE</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        onPress={() => handleShoot('miss', s.madeKey as any, s.attKey as any, s.statField)}
                        style={[styles.missBtn, { backgroundColor: colors.destructive }]}
                        activeOpacity={0.7}
                      >
                        <Ionicons name="close" size={13} color="#fff" />
                        <Text style={styles.shootBtnText}>MISS</Text>
                      </TouchableOpacity>
                      <View style={styles.undoRow}>
                        <TouchableOpacity
                          onPress={() => handleShoot('undoMake', s.madeKey as any, s.attKey as any, s.statField)}
                          disabled={made === 0}
                          style={[styles.undoBtn, { borderColor: colors.border, opacity: made === 0 ? 0.3 : 1 }]}
                        >
                          <Text style={[styles.undoBtnText, { color: colors.mutedForeground }]}>−Make</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={() => handleShoot('undoMiss', s.madeKey as any, s.attKey as any, s.statField)}
                          disabled={!hasMiss}
                          style={[styles.undoBtn, { borderColor: colors.border, opacity: hasMiss ? 1 : 0.3 }]}
                        >
                          <Text style={[styles.undoBtnText, { color: colors.mutedForeground }]}>−Miss</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  );
                })}
              </View>

              {/* ── Counting stats ── */}
              <View style={styles.countGrid}>
                {([
                  { label: 'REB', field: 'rebounds',  color: 'primary' },
                  { label: 'AST', field: 'assists',   color: 'primary' },
                  { label: 'STL', field: 'steals',    color: 'primary' },
                  { label: 'BLK', field: 'blocks',    color: 'primary' },
                  { label: 'TO',  field: 'turnovers', color: 'destructive' },
                ] as const).map((s) => {
                  const val = (selectedLine![s.field as keyof StatLine] as number);
                  const accent = s.color === 'destructive' ? colors.destructive : colors.primary;
                  return (
                    <View key={s.label} style={[styles.countCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                      <Text style={[styles.countLabel, { color: colors.mutedForeground }]}>{s.label}</Text>
                      <Text style={[styles.countValue, { color: accent }]}>{val}</Text>
                      <View style={styles.countBtns}>
                        <TouchableOpacity
                          onPress={() => handleCount(s.field as keyof StatLine, -1)}
                          disabled={val === 0}
                          activeOpacity={0.7}
                          style={[styles.countBtn, { backgroundColor: colors.muted, opacity: val === 0 ? 0.3 : 1 }]}
                        >
                          <Text style={[styles.countBtnText, { color: colors.mutedForeground }]}>−</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={() => handleCount(s.field as keyof StatLine, 1)}
                          activeOpacity={0.7}
                          style={[styles.countBtn, { backgroundColor: accent + '20', borderColor: accent + '40', borderWidth: 1 }]}
                        >
                          <Text style={[styles.countBtnText, { color: accent }]}>+</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  );
                })}
              </View>
            </>
          )}
        </ScrollView>
      )}

      {/* Save button */}
      <View style={[styles.footer, { paddingBottom: insets.bottom + (cameraCompact ? 6 : 16) }]}>
        {uploadProgress !== null ? (
          <View style={{ gap: 8 }}>
            <View style={[styles.saveBtn, { backgroundColor: colors.primary, flexDirection: 'column', gap: 6 }]}>
              <Text style={[styles.saveBtnText, { fontSize: 14 }]}>
                Uploading video… {uploadProgress}%
              </Text>
              <View style={styles.uploadTrack}>
                <View style={[styles.uploadFill, { width: `${uploadProgress}%` as any }]} />
              </View>
            </View>
            <TouchableOpacity
              onPress={handleCancelUpload}
              activeOpacity={0.8}
              style={[styles.cancelUploadBtn, { borderColor: colors.border }]}
            >
              <Ionicons name="close-circle-outline" size={16} color={colors.mutedForeground} />
              <Text style={[styles.cancelUploadText, { color: colors.mutedForeground }]}>Cancel upload</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity
            onPress={confirmSave}
            disabled={saving}
            activeOpacity={0.8}
            style={[styles.saveBtn, { backgroundColor: colors.primary }]}
          >
            {saving ? (
              <>
                <ActivityIndicator color="#fff" size="small" />
                <Text style={styles.saveBtnText}>Saving…</Text>
              </>
            ) : (
              <>
                <Ionicons name="checkmark-circle" size={20} color="#fff" />
                <Text style={styles.saveBtnText}>Save Game</Text>
              </>
            )}
          </TouchableOpacity>
        )}
      </View>
    </>
  );

  // ── Go Live sheet ──
  const goLiveSheet = liveCode ? (
    <Modal
      visible={showGoLiveSheet}
      transparent
      animationType="slide"
      onRequestClose={() => setShowGoLiveSheet(false)}
    >
      <View style={styles.sheetBackdrop}>
        <View style={[styles.sheetContainer, { backgroundColor: colors.card, borderColor: colors.border }]}>
          {/* Header */}
          <View style={styles.sheetHeader}>
            <View style={styles.sheetTitleRow}>
              <Animated.View style={[styles.sheetLiveDot, { opacity: livePulse }]} />
              <Text style={[styles.sheetTitle, { color: colors.foreground }]}>You're Live</Text>
            </View>
            <TouchableOpacity onPress={() => setShowGoLiveSheet(false)} style={styles.sheetCloseBtn}>
              <Ionicons name="close" size={20} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>

          <Text style={[styles.sheetSub, { color: colors.mutedForeground }]}>
            Share this link with viewers. They can watch the score update in real time.
          </Text>

          {/* Session code */}
          <View style={[styles.codeBox, { backgroundColor: colors.muted, borderColor: colors.border }]}>
            <Text style={[styles.codeLabel, { color: colors.mutedForeground }]}>Session code</Text>
            <Text style={[styles.codeValue, { color: colors.foreground }]}>{liveCode}</Text>
          </View>

          {/* Share link */}
          <TouchableOpacity
            onPress={() => Share.share({ message: watchUrl(liveCode), url: watchUrl(liveCode) })}
            activeOpacity={0.8}
            style={[styles.shareLinkBtn, { backgroundColor: colors.primary }]}
          >
            <Ionicons name="share-outline" size={18} color="#fff" />
            <Text style={styles.shareLinkText}>Share Watch Link</Text>
          </TouchableOpacity>

          {/* Stop broadcast */}
          <TouchableOpacity
            onPress={async () => {
              setShowGoLiveSheet(false);
              await stopLiveBroadcast(liveCode);
            }}
            activeOpacity={0.8}
            style={[styles.stopLiveBtn, { borderColor: colors.destructive + '60' }]}
          >
            <Ionicons name="stop-circle-outline" size={18} color={colors.destructive} />
            <Text style={[styles.stopLiveText, { color: colors.destructive }]}>End Broadcast</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  ) : null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
    <View style={[styles.root, isLandscape && styles.rootLandscape]}>
      {goLiveSheet}

      {/* ── Compact scoreboard header — shown when not recording (camera hidden) ── */}
      {!recordVideo && (
        <View style={[styles.scoreHeader, { paddingTop: insets.top + (Platform.OS === 'ios' ? 8 : 24), backgroundColor: colors.card, borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={handleClose} style={styles.closeBtn}>
            <Ionicons name="chevron-down" size={22} color={colors.mutedForeground} />
          </TouchableOpacity>
          <View style={styles.scoreboard}>
            <View style={styles.scoreCol}>
              <Text style={[styles.teamLabel, { color: colors.mutedForeground }]} numberOfLines={1}>{teamName}</Text>
              <Text style={[styles.scoreNum, { color: colors.foreground }]}>{teamScore}</Text>
            </View>
            <View style={styles.scoreCenter}>
              <Text style={[styles.timer, { color: colors.foreground }]}>{formatTime(seconds)}</Text>
              <TouchableOpacity
                onPress={handleStartStop}
                style={[styles.timerBtn, { backgroundColor: running ? colors.muted : colors.primary }]}
              >
                <Ionicons name={running ? 'pause' : 'play'} size={14} color="#fff" />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => { setHalf((h) => (h === 1 ? 2 : 1)); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
                style={[styles.halfBtn, { borderColor: colors.border }]}
              >
                <Text style={[styles.halfText, { color: colors.mutedForeground }]}>{half === 1 ? '1st' : '2nd'}</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.scoreCol}>
              <Text style={[styles.teamLabel, { color: colors.mutedForeground }]} numberOfLines={1}>{opponent}</Text>
              <View style={styles.oppScoreRow}>
                <TouchableOpacity
                  onPress={() => { setOpponentScore((s) => Math.max(0, s - 1)); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
                  style={[styles.oppBtn, { backgroundColor: colors.muted }]}
                  hitSlop={{ top: 14, bottom: 14, left: 14, right: 8 }}
                >
                  <Text style={[styles.oppBtnText, { color: colors.foreground }]}>−</Text>
                </TouchableOpacity>
                <Text style={[styles.scoreNum, { color: colors.foreground }]}>{opponentScore}</Text>
                {([1, 2, 3] as const).map((pts) => (
                  <TouchableOpacity
                    key={pts}
                    onPress={() => { setOpponentScore((s) => s + pts); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
                    style={[styles.oppQuickBtn, { backgroundColor: colors.primary + '20', borderColor: colors.primary + '50' }]}
                    hitSlop={{ top: 10, bottom: 10, left: 4, right: 4 }}
                  >
                    <Text style={[styles.oppQuickBtnText, { color: colors.primary }]}>+{pts}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          </View>
        </View>
      )}

      {/* ── CAMERA SECTION (top half portrait / left half landscape) ── */}
      {/* Keep this View mounted so CameraView never unmounts mid-recording */}
      <GestureDetector gesture={pinchGesture}>
      <View
        style={[
          isLandscape ? styles.cameraSectionLand : styles.cameraSectionPort,
          !previewVisible && styles.cameraSectionCollapsed,
          !recordVideo && styles.cameraSectionHidden,
        ]}
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          if (width > 0 && height > 0) setCameraContainerSize({ w: width, h: height });
        }}
      >
        {/* Camera always mounted so recording is uninterrupted when preview is hidden */}
        {cameraReady ? (
          <CameraView
            ref={cameraRef}
            style={[StyleSheet.absoluteFill, (() => {
              // Scale the CameraView so the native preview always fills (covers) the
              // container, removing black bars caused by aspect-ratio mismatches
              // (especially visible on iPad where the section is wider than the
              // camera's native 3:4 portrait preview).
              const { w: cw, h: ch } = cameraContainerSize;
              if (!cw || !ch) return {};
              // Typical iOS camera preview: 4:3 landscape, 3:4 portrait.
              const cameraAspect = isLandscape ? (4 / 3) : (3 / 4);
              const containerAspect = cw / ch;
              const scale = Math.max(
                1,
                containerAspect > cameraAspect
                  ? containerAspect / cameraAspect   // container is wider → scale to fill width
                  : cameraAspect / containerAspect,  // container is taller → scale to fill height
              );
              return scale > 1.01 ? { transform: [{ scale }] } : {};
            })()]}
            facing={cameraFacing}
            mode="video"
            zoom={cameraZoom}
            onCameraReady={onCameraReady}
          />
        ) : (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: '#0d0d0d' }]} />
        )}

        {previewVisible ? (
          <>
            {/* Scoreboard overlaid at bottom of camera section */}
            {scoreboardOverlay}

            {/* REC / CAM badge — top-right */}
            {recordVideo && (
              <View style={styles.recBadgeRow}>
                <View style={styles.recBadge}>
                  {isRecording ? <View style={styles.recDot} /> : <Ionicons name="videocam" size={10} color="#fff" />}
                  <Text style={styles.recText}>{isRecording ? 'REC' : 'CAM'}</Text>
                </View>
                {isLive && (
                  <TouchableOpacity onPress={() => setShowGoLiveSheet(true)} style={styles.liveBadge} activeOpacity={0.8}>
                    <Animated.View style={[styles.liveDot, { opacity: livePulse }]} />
                    <Text style={styles.liveText}>LIVE</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}

            {/* Camera controls — top-left */}
            {cameraReady && (
              <View style={styles.camControls}>
                {/* Flip front/back — always enabled; prompts to save clip while recording */}
                <TouchableOpacity
                  onPress={toggleCameraFacing}
                  activeOpacity={0.75}
                  style={styles.camControlBtn}
                >
                  <Ionicons name="camera-reverse" size={18} color="#fff" />
                </TouchableOpacity>

                {/* Mute / unmute mic */}
                <TouchableOpacity
                  onPress={() => { setMicMuted((m) => !m); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
                  activeOpacity={0.75}
                  style={[styles.camControlBtn, micMuted && { backgroundColor: 'rgba(239,68,68,0.75)' }]}
                >
                  <Ionicons name={micMuted ? 'mic-off' : 'mic'} size={18} color="#fff" />
                </TouchableOpacity>

                {/* Orientation lock */}
                <TouchableOpacity
                  onPress={() => {
                    const next = !(layoutLandscape !== null ? layoutLandscape : sw > sh);
                    setLayoutLandscape(next);
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  }}
                  activeOpacity={0.75}
                  style={[styles.camControlBtn, layoutLandscape !== null && { borderWidth: 1, borderColor: 'rgba(255,255,255,0.55)' }]}
                >
                  <View style={{ transform: [{ rotate: isLandscape ? '90deg' : '0deg' }] }}>
                    <Ionicons name="phone-portrait-outline" size={18} color="#fff" />
                  </View>
                </TouchableOpacity>

                {/* Dismiss preview */}
                <TouchableOpacity
                  onPress={togglePreview}
                  activeOpacity={0.75}
                  style={styles.camControlBtn}
                >
                  <Ionicons name="eye-off" size={18} color="#fff" />
                </TouchableOpacity>

                {/* Go Live / Live indicator */}
                <TouchableOpacity
                  onPress={isLive ? () => setShowGoLiveSheet(true) : startLiveBroadcast}
                  activeOpacity={0.75}
                  disabled={liveLoading}
                  style={[
                    styles.camControlBtn,
                    isLive && { backgroundColor: 'rgba(239,68,68,0.85)' },
                  ]}
                >
                  {liveLoading ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : isLive ? (
                    <Ionicons name="radio" size={18} color="#fff" />
                  ) : (
                    <Ionicons name="radio-outline" size={18} color="#fff" />
                  )}
                </TouchableOpacity>
              </View>
            )}

            {/* Permission denied — shown inside camera box */}
            {recordVideo && (!cameraPermission?.granted || !micPermission?.granted) && (
              <View style={styles.permBanner}>
                <Ionicons name="videocam-off" size={15} color="rgba(255,255,255,0.6)" />
                <Text style={styles.permText}>Camera permission needed</Text>
                <TouchableOpacity
                  onPress={async () => { await requestCameraPermission(); await requestMicPermission(); }}
                  style={[styles.permBtn, { backgroundColor: colors.primary }]}
                >
                  <Text style={styles.permBtnText}>Allow</Text>
                </TouchableOpacity>
              </View>
            )}
          </>
        ) : (
          /* Preview hidden — full-width banner with prominent restore CTA */
          <View style={styles.previewHiddenOverlay}>
            {/* Back button — always reachable even when preview is collapsed */}
            <TouchableOpacity onPress={handleClose} activeOpacity={0.75} style={styles.collapsedCloseBtn}>
              <Ionicons name="chevron-down" size={20} color="rgba(255,255,255,0.55)" />
            </TouchableOpacity>

            {/* Full-width restore CTA — fills the bar so it's impossible to miss */}
            <TouchableOpacity onPress={togglePreview} activeOpacity={0.75} style={styles.expandPreviewBtn}>
              <Ionicons name="videocam" size={17} color="#fff" />
              <Text style={styles.expandPreviewText}>Tap to show camera</Text>
              <Ionicons name="chevron-up" size={15} color="rgba(255,255,255,0.7)" style={{ marginLeft: 2 }} />
            </TouchableOpacity>

            {/* LIVE badge — always reachable even when the camera preview is collapsed */}
            {isLive && (
              <TouchableOpacity
                onPress={() => setShowGoLiveSheet(true)}
                activeOpacity={0.8}
                style={styles.collapsedLiveBadge}
              >
                <Animated.View style={[styles.liveDot, { opacity: livePulse }]} />
                <Text style={styles.liveText}>LIVE</Text>
              </TouchableOpacity>
            )}

            {recordVideo && isRecording && !isLive && (
              <View style={styles.recDotSmallRight}>
                <View style={styles.recDotSmall} />
                <Text style={styles.recDotSmallLabel}>REC</Text>
              </View>
            )}
          </View>
        )}

        {/* ── Zoom level badge — fades in on pinch, fades out after 1.4 s ── */}
        {zoomBadgeVisible && (
          <Animated.View
            pointerEvents="none"
            style={{
              position: 'absolute',
              top: 12,
              alignSelf: 'center',
              opacity: zoomBadgeOpacity,
              backgroundColor: 'rgba(0,0,0,0.52)',
              borderRadius: 20,
              paddingHorizontal: 14,
              paddingVertical: 5,
            }}
          >
            <Text style={{ color: '#fff', fontSize: 13, fontFamily: 'Inter_600SemiBold', letterSpacing: 0.5 }}>
              {(1 + cameraZoom * 4).toFixed(1)}×
            </Text>
          </Animated.View>
        )}
      </View>
      </GestureDetector>

      {/* ── STATS SECTION (bottom half portrait / right half landscape) ── */}
      <View style={[styles.statsSection, isLandscape && styles.statsSectionLand]}>
        {statArea}
      </View>
    </View>
    </GestureHandlerRootView>
  );
}

function makeStyles(colors: any, insets: any, sw: number, sh: number, isLandscape: boolean) {
  // Camera section height — bigger on tablet.
  // Portrait: 54 % of screen height (was 46 %).
  // Landscape: tablet gets 62 % width, phone gets 55 %.
  // Tablet detection: iPads (and large Android tablets) report at least 768px on
  // their short edge. Platform.isPad only exists on the iOS static type, so we
  // use a dimension heuristic that works cross-platform.
  const shortEdge = Math.min(sw, sh);
  const isTablet = shortEdge >= 768;
  // Small phones (iPhone SE, etc.) have a screen height ≤ 667 pt.  At 54 % the
  // camera alone takes ~360 pt, leaving only ~307 pt for the chip bar, stat
  // buttons, and Save button — too cramped.  Drop back to 46 % on those devices
  // so the controls section keeps the same space it had before the height bump.
  // Larger phones (≥ 750 pt) and tablets keep the 54 % / 62 % values.
  const isSmallPhone = !isTablet && sh <= 667;
  const portraitRatio = isTablet ? 0.62 : isSmallPhone ? 0.46 : 0.54;
  const cameraH = isLandscape ? sh : Math.round(sh * portraitRatio);
  const cameraLandW = isTablet ? '62%' : '55%';

  return StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    rootLandscape: { flexDirection: 'row' },
    centered: { alignItems: 'center', justifyContent: 'center' },

    // ── Offline banner ──────────────────────────────────────────────────────
    offlineBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderBottomWidth: 1,
    },
    offlineBannerText: {
      fontSize: 12,
      fontFamily: 'Inter_500Medium',
      color: '#fde68a',
      flex: 1,
    },

    // ── Camera section ─────────────────────────────────────────────────────
    cameraSectionPort: {
      width: '100%',
      height: cameraH,
      backgroundColor: '#0d0d0d',
      overflow: 'hidden',
    },
    cameraSectionLand: {
      width: cameraLandW,
      height: '100%',
      backgroundColor: '#0d0d0d',
      overflow: 'hidden',
    },

    // Scoreboard overlaid at the bottom of the camera section
    scoreOverlay: {
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      paddingTop: 8,
      paddingBottom: 10,
      paddingHorizontal: 10,
      backgroundColor: 'rgba(0,0,0,0.52)',
    },
    closeBtn: { alignSelf: 'center', padding: 4, marginBottom: 2 },
    scoreboard: { flexDirection: 'row', alignItems: 'center' },
    scoreCol: { flex: 1, alignItems: 'center' },
    teamLabel: {
      fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5,
      marginBottom: 1, fontFamily: 'Inter_500Medium',
      color: 'rgba(255,255,255,0.7)', maxWidth: 110,
    },
    scoreNum: { ...tekoStyle(44), color: '#fff' },
    scoreCenter: { alignItems: 'center', gap: 5, paddingHorizontal: 8 },
    timer: { ...tekoStyle(20, 'regular'), color: 'rgba(255,255,255,0.75)' },
    timerBtn: { width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
    halfBtn: {
      borderWidth: 1, borderRadius: 6,
      paddingHorizontal: 8, paddingVertical: 2,
      borderColor: 'rgba(255,255,255,0.3)',
    },
    halfText: { fontSize: 11, fontFamily: 'Inter_600SemiBold', color: 'rgba(255,255,255,0.75)' },
    oppScoreRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    // Compact quick-buttons used inside the dark camera overlay (white-tinted)
    oppOverlayQuickBtn: {
      paddingHorizontal: 7,
      paddingVertical: 3,
      borderRadius: 6,
      backgroundColor: 'rgba(255,255,255,0.18)',
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.35)',
    },
    oppOverlayQuickBtnText: {
      fontSize: 11,
      fontFamily: 'Inter_700Bold',
      color: '#fff',
      lineHeight: 14,
    },
    oppQuickBtn: {
      paddingHorizontal: 7,
      paddingVertical: 4,
      borderRadius: 6,
      borderWidth: 1,
      alignItems: 'center',
      justifyContent: 'center',
    },
    oppQuickBtnText: { fontSize: 12, fontFamily: 'Inter_700Bold', lineHeight: 14 },
    oppBtn: {
      width: 40, height: 40, borderRadius: 10,
      alignItems: 'center', justifyContent: 'center',
      backgroundColor: 'rgba(255,255,255,0.15)',
    },
    oppBtnText: { fontSize: 22, lineHeight: 24, fontFamily: 'Inter_600SemiBold', color: '#fff' },

    // Opponent score strip in stat area (recording mode)
    oppScoreStrip: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderBottomWidth: 1,
    },
    oppScoreStripTeam: {
      alignItems: 'center',
      minWidth: 90,
    },
    oppScoreStripLabel: {
      fontSize: 10,
      fontFamily: 'Inter_500Medium',
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      marginBottom: 1,
    },
    oppScoreStripNum: { ...tekoStyle(28) },
    oppScoreStripVs: {
      fontSize: 11,
      fontFamily: 'Inter_500Medium',
      textTransform: 'uppercase',
      letterSpacing: 1,
    },

    // Collapsed camera section (preview hidden).
    // Must be tall enough to clear the safe-area / Dynamic Island so the
    // "Tap to show camera" button is actually reachable.
    cameraSectionCollapsed: {
      height: insets.top + 56,
      minHeight: insets.top + 56,
    },
    // Hidden camera section (not recording — collapses to nothing)
    cameraSectionHidden: {
      height: 0,
      overflow: 'hidden' as const,
    },
    // Compact scoreboard shown above stats when not recording
    scoreHeader: {
      borderBottomWidth: 1,
      paddingHorizontal: 10,
      paddingBottom: 12,
    },

    // Camera control buttons — top-left
    camControls: {
      position: 'absolute',
      top: insets.top + (Platform.OS === 'web' ? 64 : 8),
      left: 10,
      flexDirection: 'column',
      gap: 6,
    },
    camControlBtn: {
      width: 34,
      height: 34,
      borderRadius: 10,
      backgroundColor: 'rgba(0,0,0,0.55)',
      alignItems: 'center',
      justifyContent: 'center',
    },

    // Overlay shown when preview is hidden
    previewHiddenOverlay: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(0,0,0,0.92)',
      borderTopWidth: 2,
      borderTopColor: 'rgba(255,255,255,0.18)',
      flexDirection: 'row',
      alignItems: 'stretch',
      // Push content below the notch / Dynamic Island so buttons are tappable
      paddingTop: insets.top,
    },
    expandPreviewBtn: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 7,
      backgroundColor: 'rgba(255,255,255,0.10)',
      borderRadius: 0,
    },
    expandPreviewText: {
      fontSize: 14,
      fontFamily: 'Inter_600SemiBold',
      color: '#fff',
      letterSpacing: 0.2,
    },
    collapsedCloseBtn: {
      width: 48,
      alignItems: 'center',
      justifyContent: 'center',
      borderRightWidth: 1,
      borderRightColor: 'rgba(255,255,255,0.1)',
    },
    recDotSmallRight: {
      width: 48,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 2,
      borderLeftWidth: 1,
      borderLeftColor: 'rgba(255,255,255,0.1)',
    },
    collapsedLiveBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 3,
      backgroundColor: 'rgba(239,68,68,0.75)',
      borderRadius: 6,
      paddingHorizontal: 7,
      paddingVertical: 4,
      width: 56,
      justifyContent: 'center',
      borderLeftWidth: 1,
      borderLeftColor: 'rgba(255,255,255,0.1)',
    },
    recDotSmallLabel: {
      fontSize: 8,
      fontFamily: 'Inter_700Bold',
      color: '#EF4444',
      letterSpacing: 0.5,
    },
    cameraHiddenBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      alignSelf: 'center',
      marginTop: 6,
      marginBottom: 2,
      borderRadius: 20,
      borderWidth: 1,
      paddingHorizontal: 10,
      paddingVertical: 3,
    },
    cameraHiddenText: {
      fontSize: 11,
      fontFamily: 'Inter_500Medium',
    },
    recDotSmall: {
      width: 7,
      height: 7,
      borderRadius: 4,
      backgroundColor: '#EF4444',
    },

    // REC / LIVE badges — top-right of camera section
    recBadgeRow: {
      position: 'absolute',
      top: insets.top + (Platform.OS === 'web' ? 64 : 8),
      right: 10,
      flexDirection: 'column',
      alignItems: 'flex-end',
      gap: 4,
    },
    recBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 3,
      backgroundColor: 'rgba(0,0,0,0.55)',
      borderRadius: 6,
      paddingHorizontal: 5,
      paddingVertical: 2,
    },
    recDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#EF4444' },
    recText: { fontSize: 9, fontFamily: 'Inter_700Bold', color: '#fff', letterSpacing: 0.5 },
    liveBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 3,
      backgroundColor: 'rgba(239,68,68,0.75)',
      borderRadius: 6,
      paddingHorizontal: 5,
      paddingVertical: 2,
    },
    liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#fff' },
    liveText: { fontSize: 9, fontFamily: 'Inter_700Bold', color: '#fff', letterSpacing: 0.5 },

    // Permission banner inside camera section
    permBanner: {
      position: 'absolute',
      bottom: 80,
      left: 12,
      right: 12,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.15)',
      backgroundColor: 'rgba(0,0,0,0.7)',
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    permText: { flex: 1, fontSize: 11, fontFamily: 'Inter_400Regular', color: 'rgba(255,255,255,0.6)' },
    permBtn: { borderRadius: 7, paddingHorizontal: 10, paddingVertical: 5 },
    permBtnText: { fontSize: 11, fontFamily: 'Inter_600SemiBold', color: '#fff' },

    // ── Stats section ──────────────────────────────────────────────────────
    statsSection: { flex: 1, backgroundColor: colors.background },
    statsSectionLand: { flex: 1 },

    playerBar: {
      borderTopWidth: 1,
      borderBottomWidth: 1,
      paddingVertical: 6,
    },
    playerChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      paddingHorizontal: 12,
      paddingVertical: 7,
      borderRadius: 20,
      borderWidth: 1,
    },
    playerChipName: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
    playerChipPts: { fontSize: 12, fontFamily: 'Inter_500Medium' },

    // Stat scroll
    statScroll: { flex: 1 },
    statContent: { padding: 10, gap: 10 },
    noPlayerText: { textAlign: 'center', fontFamily: 'Inter_400Regular', fontSize: 14, marginTop: 24 },

    // Shooting row
    shootRow: { flexDirection: 'row', gap: 7 },
    shootCard: {
      flex: 1, borderRadius: 12, borderWidth: 1,
      padding: 9, alignItems: 'center', gap: 5,
    },
    shootLabel: { fontSize: 11, fontFamily: 'Inter_700Bold', textTransform: 'uppercase', letterSpacing: 0.5 },
    shootValue: { ...tekoStyle(20) },
    makeBtn: {
      width: '100%', height: 34, borderRadius: 8,
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4,
    },
    missBtn: {
      width: '100%', height: 34, borderRadius: 8,
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4,
    },
    shootBtnText: { fontSize: 11, fontFamily: 'Inter_700Bold', color: '#fff', letterSpacing: 0.3 },
    undoRow: { flexDirection: 'row', gap: 4, width: '100%' },
    undoBtn: {
      flex: 1, height: 22, borderRadius: 6, borderWidth: 1,
      alignItems: 'center', justifyContent: 'center',
    },
    undoBtnText: { fontSize: 10, fontFamily: 'Inter_500Medium' },

    // Counting grid
    countGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
    countCard: {
      flex: 1, minWidth: '18%', borderRadius: 12, borderWidth: 1,
      padding: 9, alignItems: 'center', gap: 5,
    },
    countLabel: { fontSize: 11, fontFamily: 'Inter_700Bold', textTransform: 'uppercase', letterSpacing: 0.5 },
    countValue: { ...tekoStyle(26) },
    countBtns: { flexDirection: 'row', gap: 5, width: '100%' },
    countBtn: {
      flex: 1, height: 26, borderRadius: 8,
      alignItems: 'center', justifyContent: 'center',
    },
    countBtnText: { fontSize: 14, lineHeight: 16, fontFamily: 'Inter_700Bold' },

    // ── Opponent bar (replaces the old VS strip) ─────────────────────────────
    oppBar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 12,
      paddingVertical: 7,
      borderBottomWidth: 1,
    },
    oppBarLeft: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
      flex: 1,
      minWidth: 0,
    },
    oppBarTagPill: {
      paddingHorizontal: 5,
      paddingVertical: 2,
      borderRadius: 4,
    },
    oppBarTagText: {
      fontSize: 9,
      fontFamily: 'Inter_700Bold',
      letterSpacing: 1,
    },
    oppBarName: {
      fontSize: 14,
      fontFamily: 'Inter_600SemiBold',
      flexShrink: 1,
    },
    oppBarRight: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
    },
    oppBarScore: {
      ...tekoStyle(24),
      minWidth: 28,
      textAlign: 'center' as const,
    },

    // ── Compact stat area (camera recording mode) ─────────────────────────────
    compactStatArea: {
      flex: 1,
      paddingHorizontal: 8,
      paddingTop: 5,
      paddingBottom: 4,
      gap: 5,
    },
    compactShootGrid: { gap: 4 },
    compactBtnRow: { flexDirection: 'row', gap: 5 },
    compactShootHeaderCell: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 5,
      paddingVertical: 1,
    },
    compactShootLabel: {
      fontSize: 10,
      fontFamily: 'Inter_700Bold',
      letterSpacing: 0.5,
      textTransform: 'uppercase' as const,
    },
    compactShootCount: {
      fontSize: 12,
      fontFamily: 'Inter_600SemiBold',
    },
    compactMakeBtn: {
      flex: 1,
      height: 36,
      borderRadius: 9,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
    },
    compactMissBtn: {
      flex: 1,
      height: 36,
      borderRadius: 9,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
    },
    compactActionBtnText: {
      fontSize: 10,
      fontFamily: 'Inter_700Bold',
      color: '#fff',
      letterSpacing: 0.3,
    },
    compactUndoCell: {
      flex: 1,
      flexDirection: 'row' as const,
      gap: 3,
    },
    compactUndoBtn: {
      flex: 1,
      height: 20,
      borderRadius: 5,
      borderWidth: 1,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
    },
    compactUndoBtnText: {
      fontSize: 9,
      fontFamily: 'Inter_500Medium',
    },
    compactCountStrip: { flexDirection: 'row', gap: 4 },
    compactCountCard: {
      flex: 1,
      borderRadius: 8,
      borderWidth: 1,
      padding: 4,
      alignItems: 'center',
      gap: 2,
    },
    compactCountLabel: {
      fontSize: 9,
      fontFamily: 'Inter_700Bold',
      letterSpacing: 0.5,
      textTransform: 'uppercase' as const,
    },
    compactCountVal: { ...tekoStyle(16) },
    compactCountBtns: { flexDirection: 'row', gap: 3, width: '100%' },
    compactCountBtn: {
      flex: 1,
      height: 24,
      borderRadius: 6,
      alignItems: 'center',
      justifyContent: 'center',
    },
    compactCountBtnTxt: {
      fontSize: 12,
      fontFamily: 'Inter_700Bold',
    },

    // Footer
    footer: {
      paddingHorizontal: 14,
      paddingTop: 8,
      borderTopWidth: 1,
      borderTopColor: 'rgba(255,255,255,0.06)',
    },
    saveBtn: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
      gap: 8, height: 50, borderRadius: 13,
    },
    saveBtnText: { fontSize: 16, fontFamily: 'Inter_700Bold', color: '#fff' },
    uploadTrack: {
      width: '80%', height: 4, borderRadius: 2,
      backgroundColor: 'rgba(255,255,255,0.3)',
      overflow: 'hidden',
    },
    uploadFill: {
      height: 4, borderRadius: 2,
      backgroundColor: '#fff',
    },
    cancelUploadBtn: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
      gap: 6, height: 36, borderRadius: 10, borderWidth: 1,
    },
    cancelUploadText: {
      fontSize: 13, fontFamily: 'Inter_600SemiBold',
    },

    // ── Go Live modal sheet ────────────────────────────────────────────────
    sheetBackdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.55)',
      justifyContent: 'flex-end',
    },
    sheetContainer: {
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      borderWidth: 1,
      borderBottomWidth: 0,
      paddingHorizontal: 20,
      paddingTop: 20,
      paddingBottom: insets.bottom + 28,
      gap: 14,
    },
    sheetHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    sheetTitleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    sheetLiveDot: {
      width: 10,
      height: 10,
      borderRadius: 5,
      backgroundColor: '#EF4444',
    },
    sheetTitle: {
      fontSize: 20,
      fontFamily: 'Inter_700Bold',
    },
    sheetCloseBtn: {
      padding: 4,
    },
    sheetSub: {
      fontSize: 13,
      fontFamily: 'Inter_400Regular',
      lineHeight: 18,
    },
    codeBox: {
      borderRadius: 12,
      borderWidth: 1,
      padding: 14,
      alignItems: 'center',
      gap: 4,
    },
    codeLabel: {
      fontSize: 11,
      fontFamily: 'Inter_600SemiBold',
      textTransform: 'uppercase',
      letterSpacing: 0.8,
    },
    codeValue: {
      ...tekoStyle(36),
      letterSpacing: 6,
    },
    shareLinkBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      height: 48,
      borderRadius: 12,
    },
    shareLinkText: {
      fontSize: 15,
      fontFamily: 'Inter_700Bold',
      color: '#fff',
    },
    stopLiveBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      height: 44,
      borderRadius: 12,
      borderWidth: 1,
    },
    stopLiveText: {
      fontSize: 14,
      fontFamily: 'Inter_600SemiBold',
    },
  });
}
