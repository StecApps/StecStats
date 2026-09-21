import React, { useState, useRef, useEffect, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import {
  saveDraft,
  clearDraft,
  resolveDraft,
  queueGame,
  generateClientId,
  type ScorekeeperDraft,
} from '@/lib/offlineQueue';
import { useAutosaveDraft } from '@/lib/useAutosaveDraft';

export { PENDING_UPLOAD_KEY } from '@/lib/pendingMasterUpload';
export type { PendingUpload } from '@/lib/pendingMasterUpload';
import { PENDING_UPLOAD_KEY, type PendingUpload } from '@/lib/pendingMasterUpload';
import {
  tryAcquirePendingMasterLease,
  releasePendingMasterLease,
  updatePendingMasterUpload,
} from '@/lib/pendingMasterUpload';
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
  findNodeHandle,
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
import { LinearGradient } from 'expo-linear-gradient';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSharedValue, runOnJS } from 'react-native-reanimated';
// Daily's WebRTC fork is a native module — not available in Expo Go.
// Require it dynamically so the app degrades to score-only live stream
// instead of crashing on the module-not-found error.
let RTCPeerConnection: any = null;
let RTCIceCandidate: any = null;
let RTCSessionDescription: any = null;
let mediaDevices: any = null;
let DailyMediaView: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const rn = require('@daily-co/react-native-webrtc');
  RTCPeerConnection = rn.RTCPeerConnection;
  RTCIceCandidate = rn.RTCIceCandidate;
  RTCSessionDescription = rn.RTCSessionDescription;
  mediaDevices = rn.mediaDevices;
} catch {
  // Expo Go — WebRTC unavailable; live video will fall back to score-only
}
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  DailyMediaView = require('@daily-co/react-native-daily-js').DailyMediaView;
} catch {
  // Expo Go — Daily's native media view is unavailable.
}
import { saveGame, type StatLine, type GameEvent } from '@/lib/saveGame';
import {
  createVideoTimelineClock,
  readVideoTimelineMs,
  startVideoTimelineSegment,
  stopVideoTimelineSegment,
} from '@/lib/videoTimelineClock';
import { makeUploadStallHandler } from '@/lib/uploadStallAlert';
import { rememberLocalGameVideo } from '@/lib/localGameVideo';
import { concatSegmentsWithTimeout } from '@/lib/concatSegmentsWithTimeout';
import { fetchIceServers } from '@/lib/fetchIceServers';
import { drainPendingViewers } from '@/lib/drainPendingViewers';
import { startLiveSession } from '@/lib/startLiveSession';
import {
  HoopsCameraView,
  isHoopsCameraAvailable,
  isHoopsCameraMjpegAvailable,
  requestHoopsCameraPermissionsAsync,
  startHoopsCameraRecordingAsync,
  stopHoopsCameraRecordingAsync,
  setHoopsCameraMicrophoneMutedAsync,
  createHoopsCameraLiveVideoAsync,
  waitForHoopsCameraLiveVideoFramesAsync,
  releaseHoopsCameraLiveVideoAsync,
  startHoopsCameraMjpegAsync,
  stopHoopsCameraMjpegAsync,
  suspendHoopsCameraForSharingAsync,
  resumeHoopsCameraAfterSharingAsync,
  addHoopsCameraListener,
} from '@/modules/hoops-camera/src';
import {
  BITRATE_LADDER,
  initialBitrateState,
  nextBitrateState,
} from '@/lib/adaptiveBitrate';
import {
  dailyRecordingElapsedMs,
  cycleDailyCamera,
  setDailyMicrophoneMuted,
  startDailyBroadcast,
  stopDailyBroadcast,
  type DailyRecordingResult,
  type DailyRoomCredentials,
} from '@/lib/dailyBroadcast';

const defaultLine = (): StatLine => ({
  ftMade: 0, ftAttempted: 0,
  twoMade: 0, twoAttempted: 0,
  threeMade: 0, threeAttempted: 0,
  assists: 0, rebounds: 0,
  steals: 0, turnovers: 0, blocks: 0,
});

const CAMERA_ZOOM_STEP = 0.05;
const CAMERA_PINCH_SENSITIVITY = 0.2;

export function clampCameraZoom(zoom: number) {
  return Math.min(1, Math.max(0, zoom));
}

type RecordingCameraPreviewProps = {
  cameraRef: React.RefObject<any>;
  sharedCameraMode: boolean;
  cameraActive: boolean;
  cameraReady: boolean;
  cameraFacing: 'front' | 'back';
  cameraZoom: number;
  containerWidth: number;
  containerHeight: number;
  isLandscape: boolean;
  onCameraReady: () => void;
};

// One native AVFoundation session now owns preview, recording, and the bounded
// WebRTC frame sink. This avoids opening a competing camera capturer while the
// master recording is being written.
const ENABLE_SHARED_CAMERA_MODE = true;

// Recording runs in a native AVFoundation session. Keep CameraView isolated
// from scoring state updates so a make/miss tap does not resend new style props
// to the active native recorder while it is writing a movie file.
const RecordingCameraPreview = React.memo(
  function RecordingCameraPreview({
    cameraRef,
    sharedCameraMode,
    cameraActive,
    cameraReady,
    cameraFacing,
    cameraZoom,
    containerWidth,
    containerHeight,
    isLandscape,
    onCameraReady,
  }: RecordingCameraPreviewProps) {
    if (!cameraReady) {
      return <View style={[StyleSheet.absoluteFill, { backgroundColor: '#0d0d0d' }]} />;
    }

    if (sharedCameraMode && HoopsCameraView) {
      return (
        <HoopsCameraView
          style={StyleSheet.absoluteFill}
          facing={cameraFacing}
          active={cameraActive}
          zoom={cameraZoom}
          onPreviewReady={onCameraReady}
        />
      );
    }

    return (
      <CameraView
        ref={cameraRef}
        // Do not scale the iPad preview to "cover" this box. That artificial
        // transform cropped most of the court and became distorted on rotation.
        style={StyleSheet.absoluteFill}
        facing={cameraFacing}
        active={cameraActive}
        mode="video"
        // 720p is substantially less demanding than the iPad's default
        // recording profile and leaves headroom for responsive stat controls.
        videoQuality="720p"
        zoom={cameraZoom}
        responsiveOrientationWhenOrientationLocked
        onCameraReady={onCameraReady}
      />
    );
  },
  (previous, next) =>
    previous.cameraRef === next.cameraRef &&
    previous.sharedCameraMode === next.sharedCameraMode &&
    previous.cameraActive === next.cameraActive &&
    previous.cameraReady === next.cameraReady &&
    previous.cameraFacing === next.cameraFacing &&
    previous.cameraZoom === next.cameraZoom &&
    previous.containerWidth === next.containerWidth &&
    previous.containerHeight === next.containerHeight &&
    previous.isLandscape === next.isLandscape,
);

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
    // Camera recording is deliberately free of background roster requests.
    // On some physical Android devices a React Query refresh at 30 seconds
    // coincided with the camera/network native modules becoming unresponsive.
    // Focus refresh still keeps the roster current before recording begins.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: { refetchInterval: recordVideo ? false : 30_000 } as any,
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
              setGameStarted(
                draft.seconds > 0 ||
                draft.events.length > 0 ||
                draft.opponentScore !== 0 ||
                draft.teamScoreAdj !== 0,
              );
            },
          },
        ],
      );
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [selectedPlayerId, setSelectedPlayerId] = useState<number | null>(null);
  const [stats, setStats] = useState<Record<number, StatLine>>({});
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [gameStarted, setGameStarted] = useState(false);

  // ── Offline / connectivity state ───────────────────────────────────────────
  const [isOnline, setIsOnline] = useState(true);
  // Mirror in a ref so async callbacks read the latest value without stale closures.
  const isOnlineRef = useRef(true);
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
  const [uploadRetryGeneration, setUploadRetryGeneration] = useState(0);
  const handledUploadRetryGenerationRef = useRef(0);
  // Guards against stacking multiple stall alerts if progress stays frozen.
  const stallAlertActiveRef = useRef(false);
  // Latches to true after the coach taps 'Keep waiting' once.  Prevents a
  // second identical alert from firing if the upload stays frozen — the coach
  // has already been warned and has chosen to wait, so re-alerting every 45 s
  // only increases anxiety without giving them new information.
  const stallFiredOnceRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startRef = useRef<number>(0);
  // Reel timestamps must follow bytes that actually exist in the final movie,
  // not the game clock. Each camera segment advances this clock only while it
  // is recording; camera-switch/finalization gaps are excluded because the
  // uploaded segments are concatenated without those gaps.
  const videoTimelineClockRef = useRef(createVideoTimelineClock());
  // Broadcaster-side signaling WebSocket — kept open for the duration of a live session
  const liveWsRef = useRef<WebSocket | null>(null);
  const broadcasterJoinedRef = useRef(false);
  const pendingVideoModeRef = useRef<{
    code: string;
    hasVideo: boolean;
    videoMode: 'webrtc' | 'mjpeg' | 'none';
  } | null>(null);
  // Server-issued broadcaster authorization. It must accompany every
  // join-broadcaster, including later mode updates and reconnects.
  const broadcasterTokenRef = useRef<string | null>(null);
  const pendingClientDiagnosticsRef = useRef<Array<{
    code: string;
    category: string;
    details: Record<string, unknown>;
  }>>([]);
  // WebRTC broadcaster: one RTCPeerConnection per connected viewer (keyed by viewerId)
  const webrtcPeersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  // Per-viewer ICE restart attempt counters — reset when a viewer's connection recovers
  const iceRestartCountRef = useRef<Map<string, number>>(new Map());
  // Per-viewer disconnect-state watchdog timers (preemptive ICE restart after 10 s)
  const disconnectWatchdogRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Per-viewer adaptive-bitrate poll intervals — cleared when a peer is torn down
  const bitrateIntervalRef = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());
  const outboundStartupWatchdogRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Viewer IDs for which createPeerForViewer is currently in-flight.
  // Prevents duplicate concurrent peer-creation attempts for the same viewer
  // (e.g. two rapid new-viewer messages after a WS reconnect storm).
  const peerCreationInFlightRef = useRef<Map<string, number>>(new Map());
  // Live camera MediaStream used for WebRTC. In the shared iOS build this is
  // backed by HoopsCamera's existing capture session instead of getUserMedia.
  const webrtcStreamRef = useRef<any>(null);
  const sharedStreamSessionRef = useRef<string | null>(null);
  // Invalidates async native video/audio acquisition when Live stops, the
  // invite changes, or a reconnect starts a new WebSocket session.
  const liveMediaGenerationRef = useRef(0);
  // Every broadcaster WebSocket lifecycle gets a unique generation. Peer
  // creation and ICE callbacks must never publish into a newer session.
  const liveSessionGenerationRef = useRef(0);
  // Optional audio-only stream. Keeping audio acquisition separate means an
  // audio permission/device failure never prevents shared-camera video live.
  const webrtcAudioStreamRef = useRef<any>(null);
  // Viewer IDs that sent new-viewer while a live video stream was in-flight
  // (including the shared native stream after a camera flip). Drained as soon
  // as video is ready; optional audio must not hold this queue.
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
  const mjpegFallbackActiveRef = useRef(false);
  const mjpegFallbackTransitionRef = useRef(false);
  const mjpegFallbackGenerationRef = useRef(0);
  const mjpegFrameSubscriptionRef = useRef<{ remove: () => void } | null>(null);
  const liveVideoTransportErrorRef = useRef<string | null>(null);
  const diagnosticAckResolversRef = useRef<Map<string, () => void>>(new Map());
  // Mirrors the latest team/opponent scores so reconnect callbacks don't
  // depend on derived consts that are declared later in the function body.
  const latestScoresRef = useRef({ teamScore: 0, opponentScore: 0 });

  // Camera / recording state
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [micPermission, requestMicPermission] = useMicrophonePermissions();
  const cameraRef = useRef<any>(null);
  const [isRecording, setIsRecording] = useState(false);
  const recordingPromiseRef = useRef<Promise<{ uri: string } | undefined> | null>(null);
  const recordingCompletionRef = useRef<{
    resolve: (recording: { uri: string } | undefined) => void;
    reject: (error: unknown) => void;
  } | null>(null);
  // All clip URIs collected so far (one per camera-flip segment + final clip).
  const recordedUrisRef = useRef<string[]>([]);
  // A lifecycle stop is native-owned. This remains true while the finalized
  // clip is settling, and is cleared only by the matching native resume event.
  const lifecycleInterruptedRef = useRef(false);
  const lifecycleResumeHandledRef = useRef<string | null>(null);
  const lifecycleFinalizedRef = useRef(true);
  const lifecycleResumePendingRef = useRef(false);
  const recordingDesiredRef = useRef(false);
  const unexpectedRecordingResumePendingRef = useRef(false);
  const nativeRecordingActiveRef = useRef(false);
  const pendingClockStartRef = useRef(false);
  const recordingRecoveryWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordingFailureRecoveryRef = useRef(false);
  const startRecordingRef = useRef<(() => Promise<void>) | null>(null);
  // Saving is terminal for this recording session: a delayed native resume
  // event must never start another segment after End Game was tapped.
  const recordingTerminalIntentRef = useRef(false);
  // Generation counter: incremented on each new startRecording call so the
  // finally block of an older recording doesn't clobber a newer one's state.
  const recordingGenerationRef = useRef(0);
  const recordingStartedRef = useRef(false);
  const recordingFinishedForSaveRef = useRef<
    ((details: Record<string, unknown>) => void) | null
  >(null);
  const cameraReadyRef = useRef(false);
  const pendingRecordRef = useRef(false);
  const sharedCameraMode =
    ENABLE_SHARED_CAMERA_MODE &&
    Platform.OS === 'ios' &&
    isHoopsCameraAvailable;
  const [hoopsCameraPermission, setHoopsCameraPermission] = useState<{
    camera: string;
    microphone: string;
  } | null>(null);

  function addRecordedUri(uri: string | undefined) {
    if (!uri) return;
    if (recordedUrisRef.current.includes(uri)) return;
    recordedUrisRef.current.push(uri);
  }

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
    setCameraZoom(clampCameraZoom(zoom));
    setZoomBadgeVisible(true);
    zoomBadgeOpacity.stopAnimation();
    Animated.timing(zoomBadgeOpacity, { toValue: 1, duration: 120, useNativeDriver: true }).start();
    if (zoomHideTimer.current) clearTimeout(zoomHideTimer.current);
    zoomHideTimer.current = setTimeout(() => {
      Animated.timing(zoomBadgeOpacity, { toValue: 0, duration: 400, useNativeDriver: true }).start(() => setZoomBadgeVisible(false));
    }, 1400);
  }

  function adjustCameraZoom(delta: number) {
    showZoomBadge(cameraZoom + delta);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }

  const pinchGesture = Gesture.Pinch()
    .onStart(() => {
      pinchBaseZoom.value = cameraZoom;
    })
    .onUpdate((e) => {
      // Keep two-finger adjustments gradual so a small pinch cannot jump from
      // a full-court view to a tight crop while the coach is recording.
      const newZoom = Math.min(
        1,
        Math.max(0, pinchBaseZoom.value + (e.scale - 1) * CAMERA_PINCH_SENSITIVITY),
      );
      runOnJS(showZoomBadge)(newZoom);
    });

  // Live broadcast state
  const [liveCode, setLiveCode] = useState<string | null>(null);
  const liveCodeRef = useRef<string | null>(liveCode);
  liveCodeRef.current = liveCode;
  const [isLive, setIsLive] = useState(false);
  const [liveMediaRecoveryGeneration, setLiveMediaRecoveryGeneration] = useState(0);
  const [liveLoading, setLiveLoading] = useState(false);
  const [dailyLive, setDailyLive] = useState(false);
  const [dailyLocalVideoTrack, setDailyLocalVideoTrack] = useState<any>(null);
  const dailyLiveRef = useRef(false);
  const dailyCredentialsRef = useRef<DailyRoomCredentials | null>(null);
  const dailyRecordingRef = useRef<DailyRecordingResult | null>(null);
  const dailyRecordingCodeRef = useRef<string | null>(null);
  const youtubeLiveDistributedRef = useRef(false);
  const liveStopPromiseRef = useRef<Promise<void> | null>(null);
  const [dailyProcessing, setDailyProcessing] = useState(false);
  const [showGoLiveSheet, setShowGoLiveSheet] = useState(false);
  const [isSharingLiveLink, setIsSharingLiveLink] = useState(false);
  const isSharingLiveLinkRef = useRef(false);
  const [cameraRecoveryBlocked, setCameraRecoveryBlocked] = useState(false);
  const [cameraNotice, setCameraNotice] = useState<string | null>(null);
  const cameraNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sharePresentationAnchorRef = useRef<View>(null);
  const pendingShareRef = useRef<{ code: string; anchor?: number } | null>(null);
  // A timed-out POST may still have committed server-side. Reuse this ID on
  // retries so the server returns that same session instead of creating a
  // second invite link.
  const liveStartRequestIdRef = useRef<string | null>(null);
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
  useEffect(() => () => {
    if (cameraNoticeTimerRef.current) clearTimeout(cameraNoticeTimerRef.current);
  }, []);

  // ─── Live broadcast helpers ────────────────────────────────────────────────
  function watchUrl(code: string): string {
    const publicOrigin = API_BASE || (
      process.env.EXPO_PUBLIC_DOMAIN ? `https://${process.env.EXPO_PUBLIC_DOMAIN}` : ''
    );
    return publicOrigin ? `${publicOrigin}/watch/${encodeURIComponent(code)}` : '';
  }

  function showCameraNotice(message: string) {
    setCameraNotice(message);
    if (cameraNoticeTimerRef.current) clearTimeout(cameraNoticeTimerRef.current);
    cameraNoticeTimerRef.current = setTimeout(() => {
      setCameraNotice(null);
      cameraNoticeTimerRef.current = null;
    }, 3200);
  }

  async function activateLiveBroadcast(code: string, daily?: DailyRoomCredentials) {
    if (isLive) return;
    if (recordingStartedRef.current || isRecording) {
      setShowGoLiveSheet(false);
      showCameraNotice('Recording protected — start Live before recording.');
      return;
    }
    if (!daily) {
      Alert.alert('Live unavailable', 'The server did not return a Daily video room. Please update the app and try again.');
      return;
    }
    try {
      // Daily is the sole camera owner for Live. Do this before changing
      // isLive so the legacy HoopsCamera/WebRTC effect cannot race it.
      await startDailyBroadcast(daily, setDailyLocalVideoTrack);
      dailyLiveRef.current = true;
      setDailyLive(true);

      // Daily must be connected before the server can publish its RTMP
      // output to YouTube. The server owns the YouTube broadcast and stream
      // key; the mobile client only receives the resulting video metadata.
      const youtubeToken = await getToken();
      const youtubeResponse = await fetch(
        `${API_BASE}/api/live/${encodeURIComponent(code)}/youtube/start`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(youtubeToken ? { Authorization: `Bearer ${youtubeToken}` } : {}),
          },
        },
      );
      const youtubePayload = await youtubeResponse.json().catch(() => ({}));
      if (!youtubeResponse.ok) {
        const youtubeCode = (youtubePayload as any)?.code;
        const message =
          youtubeCode === 'YOUTUBE_NOT_CONNECTED'
            ? 'Connect your YouTube account in Profile before going Live.'
            : youtubeCode === 'YOUTUBE_RECONNECT_REQUIRED'
              ? 'Reconnect your YouTube account in Profile, then try again.'
              : youtubeCode === 'YOUTUBE_LIVE_NOT_ENABLED'
                ? 'Enable YouTube Live for your channel and try again. First activation may take up to 24 hours.'
                : (youtubePayload as any)?.error ?? `YouTube Live could not start (${youtubeResponse.status}).`;
        throw Object.assign(new Error(message), { youtubeCode });
      }
      youtubeLiveDistributedRef.current = true;
      // Keep the public StecStats watch link as the only link shared with
      // viewers. videoId/watchUrl are intentionally not exposed here.
    } catch (error: any) {
      // Roll back both Daily and the server-side live session. This also keeps
      // the normal /live/:code/stop cleanup path authoritative.
      await stopLiveBroadcast(code).catch(() => {});
      youtubeLiveDistributedRef.current = false;
      dailyLiveRef.current = false;
      setDailyLive(false);
      dailyRecordingRef.current = null;
      dailyRecordingCodeRef.current = null;
      setDailyProcessing(false);
      if (error?.youtubeCode === 'YOUTUBE_NOT_CONNECTED' ||
          error?.youtubeCode === 'YOUTUBE_RECONNECT_REQUIRED' ||
          error?.youtubeCode === 'YOUTUBE_LIVE_NOT_ENABLED') {
        Alert.alert('YouTube Live unavailable', error.message);
      } else {
        Alert.alert('Live video unavailable', error?.message ?? 'Could not open the Daily camera.');
      }
      return;
    }
    setIsLive(true);
    // The compiled iOS pipeline deliberately shares one capture session
    // between local recording and the viewer video. Older binaries retain the
    // score-only safety behavior while recording.
    webrtcCameraFailedRef.current = recordVideo && !sharedCameraMode;
    // Daily carries media; retain the existing socket only for scoreboard
    // updates until the web viewer is migrated to Daily.
    connectBroadcasterWs(code, teamScore, opponentScore);
  }

  function shareLiveLink(code: string) {
    const url = watchUrl(code);
    if (!url) {
      Alert.alert('Share Link Unavailable', 'The public app address is missing. Close and reopen StecStats, then try Go Live again.');
      return;
    }
    if (recordingStartedRef.current || isRecording) {
      Alert.alert(
        'Keep recording open',
        'Opening Messages backgrounds StecStats, and iPadOS pauses the active camera. Share the live link before you start the game clock. The watch address is shown below so another device can also enter it manually.',
      );
      return;
    }
    // The invite exists, but the live socket and WebRTC stack are not started
    // yet. Legacy CameraView pauses while Messages is open. The shared native
    // session stays active and lets iOS handle its interruption in place.
    // Dismiss the React Native Modal first; iPadOS presents Share.share from
    // Modal.onDismiss rather than racing another native presentation against
    // the modal animation.
    const anchor = findNodeHandle(sharePresentationAnchorRef.current) ?? undefined;
    pendingShareRef.current = { code, anchor };
    // The previous preview readiness is no longer valid once CameraView is
    // deactivated for Messages. Recording must wait for a fresh ready callback.
    cameraReadyRef.current = false;
    isSharingLiveLinkRef.current = true;
    setIsSharingLiveLink(true);
    setShowGoLiveSheet(false);
    if (Platform.OS !== 'ios') {
      // Modal.onDismiss is iOS-only. Android's share dialog is not a popover,
      // so schedule it after the modal state update instead.
      setTimeout(() => { void sharePendingLiveLink(); }, 0);
    }
  }

  async function sharePendingLiveLink() {
    const pending = pendingShareRef.current;
    if (!pending) return;
    pendingShareRef.current = null;
    const url = watchUrl(pending.code);
    const anchor = pending.anchor;
    let didShare = false;
    let recoveryFailed = false;
    const withTimeout = async <T,>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> =>
      Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(message)), timeoutMs);
        }),
      ]);
    try {
      if (sharedCameraMode) {
        // Resolves only after stopRunning() completes on the native camera
        // queue. Do not present Messages while capture is still active.
        await withTimeout(
          suspendHoopsCameraForSharingAsync(),
          4_000,
          'The iPad camera did not stop safely before sharing.',
        );
      }
      const result = await Share.share({
        title: `${teamName} live game`,
        message: `Watch ${teamName} live: ${url}`,
      }, Platform.OS === 'ios' && anchor ? {
        anchor,
      } : undefined);
      if (result.action === Share.sharedAction) {
        didShare = true;
      }
    } catch (err: any) {
      Alert.alert('Could not open sharing', err?.message ?? 'The iPad share sheet could not be opened. Please try again.');
    } finally {
      try {
        if (sharedCameraMode) {
          // Resolves only after startRunning() succeeds. Live and recording
          // remain unavailable until this native acknowledgement.
          await withTimeout(
            resumeHoopsCameraAfterSharingAsync(),
            8_000,
            'The iPad camera did not restart after Messages.',
          );
        }
        if (didShare) {
          setCameraRecoveryBlocked(false);
          void activateLiveBroadcast(pending.code, dailyCredentialsRef.current ?? undefined);
        }
      } catch (error: any) {
        didShare = false;
        recoveryFailed = true;
        setCameraRecoveryBlocked(true);
        Alert.alert(
          'Camera did not recover',
          error?.message ?? 'The iPad camera did not restart after Messages. Close and reopen StecStats before recording this game.',
        );
      }
      isSharingLiveLinkRef.current = false;
      setIsSharingLiveLink(false);
      // Cancel and presentation errors leave the invite available so the
      // coach can retry without creating a second live session.
      if (!didShare && !recoveryFailed) setShowGoLiveSheet(true);
    }
  }

  async function startLiveBroadcast() {
    if (liveLoading || isLive) return;
    // A fresh invite is a new authorization lifecycle. Reconnects within the
    // same lifecycle retain the token returned below.
    broadcasterTokenRef.current = null;
    if (recordingStartedRef.current || isRecording) {
      // Starting WebRTC audio or presenting native UI after AVCaptureMovieFileOutput
      // has begun can interrupt iPad recording and silently finalize a short,
      // playable prefix. Live and recording may run together, but Live must own
      // the camera/audio session first.
      showCameraNotice('Recording protected — start Live before recording.');
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      return;
    }

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
      const requestId = liveStartRequestIdRef.current ?? generateClientId();
      liveStartRequestIdRef.current = requestId;
      const res = await startLiveSession({
        apiBase: API_BASE,
        opponent: opponent as string,
        teamName: teamName as string,
        requestId,
        getToken,
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
      const payload = await res.json();
      const { code } = payload;
      broadcasterTokenRef.current = payload.broadcasterToken ?? null;
      const daily: DailyRoomCredentials | undefined =
        payload.daily ?? (payload.roomUrl && payload.token
          ? { url: payload.roomUrl, token: payload.token, roomName: payload.roomName }
          : payload.dailyUrl && payload.dailyToken
          ? { url: payload.dailyUrl, token: payload.dailyToken, roomName: payload.dailyRoomName }
          : undefined);
      dailyCredentialsRef.current = daily ?? null;
      setLiveCode(code);
      liveStartRequestIdRef.current = null;
      setShowGoLiveSheet(true);
      // Do not connect the broadcaster yet. The coach can open Messages and
      // send the invite while the camera and live socket are both inactive.
      // Broadcasting begins after Share reports success or the coach taps
      // "Start Live Now" after returning to StecStats.
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
    const outboundWatchdog = outboundStartupWatchdogRef.current.get(viewerId);
    if (outboundWatchdog) {
      clearTimeout(outboundWatchdog);
      outboundStartupWatchdogRef.current.delete(viewerId);
    }
    iceRestartCountRef.current.delete(viewerId);
    const pc = webrtcPeersRef.current.get(viewerId);
    if (pc) { try { pc.close(); } catch {} webrtcPeersRef.current.delete(viewerId); }
  }

  function closeAllWebRtcPeers() {
    for (const timer of disconnectWatchdogRef.current.values()) {
      clearTimeout(timer);
    }
    disconnectWatchdogRef.current.clear();
    for (const timer of outboundStartupWatchdogRef.current.values()) {
      clearTimeout(timer);
    }
    outboundStartupWatchdogRef.current.clear();
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
    const videoStream = webrtcStreamRef.current;
    const audioStream = webrtcAudioStreamRef.current;
    webrtcStreamRef.current = null;
    webrtcAudioStreamRef.current = null;
    sharedStreamSessionRef.current = null;

    if (sharedCameraMode && videoStream) {
      // The shared video track is owned by HoopsCamera's AVFoundation
      // session. Stopping that WebRTC track would also stop local preview and
      // recording, so release it through the native facade instead.
      void releaseHoopsCameraLiveVideoAsync().catch(() => undefined);
    } else {
      videoStream?.getTracks?.().forEach((t: any) => t.stop());
    }
    audioStream?.getTracks?.().forEach((t: any) => t.stop());
  }

  function stopMjpegFallback(): Promise<void> {
    mjpegFallbackGenerationRef.current += 1;
    mjpegFallbackActiveRef.current = false;
    mjpegFallbackTransitionRef.current = false;
    mjpegFrameSubscriptionRef.current?.remove();
    mjpegFrameSubscriptionRef.current = null;
    return stopHoopsCameraMjpegAsync().catch(() => undefined);
  }

  async function startMjpegWithTimeout(): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        startHoopsCameraMjpegAsync(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('HoopsCamera MJPEG start timed out.')),
            3_000,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async function startMjpegFallback(code: string, reason: string) {
    if (
      !sharedCameraMode ||
      recordingTerminalIntentRef.current ||
      mjpegFallbackActiveRef.current ||
      mjpegFallbackTransitionRef.current ||
      liveCodeRef.current !== code
    ) return;
    if (!isHoopsCameraMjpegAvailable()) {
      webrtcCameraFailedRef.current = true;
      liveVideoTransportErrorRef.current = 'HoopsCamera MJPEG is unavailable in this build.';
      broadcastVideoModeWhenJoined(code, false, 'none');
      return;
    }
    const fallbackGeneration = ++mjpegFallbackGenerationRef.current;
    mjpegFallbackTransitionRef.current = true;
    try {
      let resolveFirstFrame!: () => void;
      const firstFrame = new Promise<void>((resolve) => {
        resolveFirstFrame = resolve;
      });
      mjpegFrameSubscriptionRef.current?.remove();
      mjpegFrameSubscriptionRef.current = addHoopsCameraListener('onMjpegFrame', (event) => {
        resolveFirstFrame();
        const ws = liveWsRef.current;
        if (
          !mjpegFallbackActiveRef.current ||
          liveCodeRef.current !== code ||
          !ws ||
          ws.readyState !== WebSocket.OPEN ||
          (ws.bufferedAmount ?? 0) > 512 * 1024
        ) return;
        ws.send(JSON.stringify({ type: 'video-frame', code, frame: event.base64 }));
      });
      await startMjpegWithTimeout();
      let firstFrameTimeout: ReturnType<typeof setTimeout> | null = null;
      try {
        await Promise.race([
          firstFrame,
          new Promise<never>((_, reject) => {
            firstFrameTimeout = setTimeout(
              () => reject(new Error('HoopsCamera MJPEG did not produce a camera frame.')),
              3_000,
            );
          }),
        ]);
      } finally {
        if (firstFrameTimeout) clearTimeout(firstFrameTimeout);
      }
      // An older native start may settle after a newer fallback already owns
      // the listener. Never let that stale continuation tear down the owner.
      if (fallbackGeneration !== mjpegFallbackGenerationRef.current) return;
      if (liveCodeRef.current !== code) {
        stopMjpegFallback();
        return;
      }
      mjpegFallbackActiveRef.current = true;
      webrtcCameraFailedRef.current = false;
      liveVideoTransportErrorRef.current = null;
      closeAllWebRtcPeers();
      stopWebRtcStream();
      broadcastClientDiagnostic('live-video-mjpeg-fallback', { reason });
      broadcastVideoModeWhenJoined(code, true, 'mjpeg');
    } catch (error) {
      if (fallbackGeneration !== mjpegFallbackGenerationRef.current) return;
      await stopMjpegFallback();
      webrtcCameraFailedRef.current = true;
      const message = error instanceof Error ? error.message : String(error);
      liveVideoTransportErrorRef.current = message;
      broadcastClientDiagnostic('live-video-mjpeg-failed', {
        reason,
        message,
      });
      // A JS timeout cannot cancel work already queued in a native module.
      // Never stack retries on the AVFoundation path. The next authoritative
      // camera-ready/recording event may make one fresh attachment attempt.
      broadcastVideoModeWhenJoined(code, false, 'none');
    } finally {
      if (fallbackGeneration === mjpegFallbackGenerationRef.current) {
        mjpegFallbackTransitionRef.current = false;
      }
    }
  }

  async function createPeerForViewer(
    viewerId: string,
    code: string,
    sessionGeneration = liveSessionGenerationRef.current,
  ) {
    if (!RTCPeerConnection) return; // native module not available (Expo Go)
    const isCurrentSession = () =>
      liveSessionGenerationRef.current === sessionGeneration;
    // Guard against concurrent duplicate calls for the same viewer (e.g. two
    // rapid new-viewer messages arriving during a WS reconnect storm).  If a
    // creation is already in-flight for this viewer, the second call would
    // tear down the peer the first is building, leaving both in a broken state.
    if (peerCreationInFlightRef.current.has(viewerId) &&
        peerCreationInFlightRef.current.get(viewerId) === sessionGeneration) {
      console.log(`[WebRTC] createPeerForViewer: already in-flight for ${viewerId} — skipping`);
      return;
    }
    peerCreationInFlightRef.current.set(viewerId, sessionGeneration);
    try {
    // Close and fully clean up any prior peer for this viewer before replacing it.
    // Without this, the old peer's callbacks keep firing and can send conflicting
    // ICE-restart offers or peer-connection-failed after the viewer has reconnected.
    teardownPeerForViewer(viewerId);
    const iceServers = await fetchIceServers(API_BASE);
    if (!isCurrentSession() || !webrtcStreamRef.current) return;
    const pc = new RTCPeerConnection({ iceServers });
    if (!isCurrentSession()) {
      try { pc.close(); } catch {}
      return;
    }
    webrtcPeersRef.current.set(viewerId, pc);

    // Add the shared/native video tracks and optional audio tracks to each
    // viewer. Audio is intentionally a separate getUserMedia call so it
    // cannot open a second camera capturer or take down shared video.
    for (const source of [webrtcStreamRef.current, webrtcAudioStreamRef.current]) {
      if (source) {
        for (const track of source.getTracks()) {
          pc.addTrack(track, source);
        }
      }
    }

    // Relay locally gathered ICE candidates to this viewer
    pc.onicecandidate = (event: any) => {
      if (event.candidate) {
        if (!isCurrentSession() || webrtcPeersRef.current.get(viewerId) !== pc) return;
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
      if (!isCurrentSession() || webrtcPeersRef.current.get(viewerId) !== pc) return;
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
        if (!isCurrentSession() || webrtcPeersRef.current.get(viewerId) !== pc) return;
        await pc.setLocalDescription(offer as any);
        if (!isCurrentSession() || webrtcPeersRef.current.get(viewerId) !== pc) return;
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
      if (!isCurrentSession()) return;
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
    let consecutiveZeroOutboundPolls = 0;
    let outboundSuccessReported = false;

    const bitrateInterval = setInterval(async () => {
      if (!isCurrentSession() || webrtcPeersRef.current.get(viewerId) !== pc) return;
      if ((pc as any).connectionState !== 'connected') return;
      try {
        const stats: RTCStatsReport = await pc.getStats();
        let rtt = 0;
        let fractionLost = 0;
        let outboundFramesEncoded = 0;
        let outboundBytesSent = 0;
        let sawOutboundVideo = false;
        stats.forEach((report: any) => {
          if (report.type === 'remote-inbound-rtp' && report.kind === 'video') {
            if (typeof report.roundTripTime === 'number') rtt = report.roundTripTime;
            if (typeof report.fractionLost === 'number') fractionLost = report.fractionLost;
          }
          if (report.type === 'outbound-rtp' && report.kind === 'video' && !report.isRemote) {
            sawOutboundVideo = true;
            if (typeof report.framesEncoded === 'number') outboundFramesEncoded += report.framesEncoded;
            if (typeof report.bytesSent === 'number') outboundBytesSent += report.bytesSent;
          }
        });

        if (sawOutboundVideo && outboundFramesEncoded === 0 && outboundBytesSent === 0) {
          consecutiveZeroOutboundPolls += 1;
          if (consecutiveZeroOutboundPolls >= 2) {
            void startMjpegFallback(code, 'outbound-rtp-zero');
            return;
          }
        } else if (sawOutboundVideo) {
          consecutiveZeroOutboundPolls = 0;
          if (!outboundSuccessReported) {
            outboundSuccessReported = true;
            broadcastClientDiagnostic('live-video-outbound-ready', {
              viewerId,
              framesEncoded: outboundFramesEncoded,
              bytesSent: outboundBytesSent,
            });
          }
        }

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
    if (!isCurrentSession() || !webrtcStreamRef.current ||
        webrtcPeersRef.current.get(viewerId) !== pc) {
      if (webrtcPeersRef.current.get(viewerId) === pc) teardownPeerForViewer(viewerId);
      else { try { pc.close(); } catch {} }
      return;
    }
    await pc.setLocalDescription(offer as any);
    if (!isCurrentSession() || !webrtcStreamRef.current ||
        webrtcPeersRef.current.get(viewerId) !== pc) {
      if (webrtcPeersRef.current.get(viewerId) === pc) teardownPeerForViewer(viewerId);
      else { try { pc.close(); } catch {} }
      return;
    }
    broadcastWsSend({ type: 'offer', code, targetId: viewerId, sdp: (offer as any).sdp });
    const outboundWatchdog = setTimeout(() => {
      outboundStartupWatchdogRef.current.delete(viewerId);
      if (
        isCurrentSession() &&
        webrtcPeersRef.current.get(viewerId) === pc &&
        (pc as any).connectionState !== 'connected'
      ) {
        void startMjpegFallback(code, 'peer-not-connected');
      }
    }, 15_000);
    outboundStartupWatchdogRef.current.set(viewerId, outboundWatchdog);
    } finally {
      // Always remove the in-flight guard so a future new-viewer for this
      // viewer can create a fresh peer (e.g. after the viewer rejoins).
      if (peerCreationInFlightRef.current.get(viewerId) === sessionGeneration) {
        peerCreationInFlightRef.current.delete(viewerId);
      }
    }
  }

  async function stopLiveBroadcast(code: string) {
    if (liveStopPromiseRef.current) {
      return liveStopPromiseRef.current;
    }
    const stopPromise = (async () => {
      const youtubeDistributed = youtubeLiveDistributedRef.current;
      let serverStopSucceeded = false;
      // An intentional stop begins a new idempotency lifecycle. A future
      // broadcast must not resume this invite code.
      liveStartRequestIdRef.current = null;
      broadcasterTokenRef.current = null;
      liveSessionGenerationRef.current += 1;
      liveMediaGenerationRef.current += 1;

      // YouTube RTMP must be stopped while the Daily room still exists.
      // Otherwise the server cannot finalize the distributed broadcast.
      try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 5000);
        try {
          const token = await Promise.race([
            getToken(),
            new Promise<null>((_, rej) => setTimeout(() => rej(new Error('getToken timeout')), 4000)),
          ]);
          const response = await fetch(`${API_BASE}/api/live/${encodeURIComponent(code)}/stop`, {
            method: 'POST',
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            signal: ac.signal,
          });
          if (!response.ok) throw new Error(`Server returned HTTP ${response.status}`);
          serverStopSucceeded = true;
        } finally {
          clearTimeout(timer);
        }
      } catch (error: any) {
        if (youtubeDistributed) {
          Alert.alert(
            'Live stop needs retry',
            `YouTube could not be stopped cleanly (${error?.message ?? 'connection failed'}). The live session is retained; try End Broadcast again when you are back online.`,
          );
        }
      }

      if (dailyLiveRef.current) {
        setDailyProcessing(true);
        dailyRecordingCodeRef.current = code;
        dailyRecordingRef.current = await stopDailyBroadcast().catch(() => null);
        dailyLiveRef.current = false;
        setDailyLive(false);
      }
      // Dismiss the go-live sheet first so it doesn't linger open while the
      // stop sequence runs (handles the case where handleSave calls us directly
      // without the sheet's own dismiss-then-stop button handler).
      setShowGoLiveSheet(false);
      // Mark as intentional BEFORE closing so ws.onclose does not schedule a
      // reconnect — even if the stop-API call below is slow or hangs.
      liveWsIntentionalCloseRef.current = true;
      closeAllWebRtcPeers();
      stopWebRtcStream();
      await stopMjpegFallback();
      if (liveWsReconnectRef.current) {
        clearTimeout(liveWsReconnectRef.current);
        liveWsReconnectRef.current = null;
      }
      if (liveWsRef.current) {
        liveWsRef.current.close();
        liveWsRef.current = null;
      }

      if (serverStopSucceeded || !youtubeDistributed) {
        youtubeLiveDistributedRef.current = false;
        setIsLive(false);
        setLiveCode(null);
        liveCodeRef.current = null;
        pendingClientDiagnosticsRef.current = [];
        for (const resolve of diagnosticAckResolversRef.current.values()) resolve();
        diagnosticAckResolversRef.current.clear();
      }
    })();
    liveStopPromiseRef.current = stopPromise;
    try {
      await stopPromise;
    } finally {
      if (liveStopPromiseRef.current === stopPromise) {
        liveStopPromiseRef.current = null;
      }
    }
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

  function broadcastClientDiagnostic(
    category: string,
    details: Record<string, unknown>,
  ) {
    const code = liveCodeRef.current;
    if (!code) return;
    const ws = liveWsRef.current;
    if (
      broadcasterJoinedRef.current &&
      ws &&
      ws.readyState === WebSocket.OPEN
    ) {
      ws.send(JSON.stringify({
        type: 'client-diagnostic',
        code,
        category,
        details,
      }));
      return;
    }
    pendingClientDiagnosticsRef.current = [
      ...pendingClientDiagnosticsRef.current.slice(-7),
      { code, category, details },
    ];
  }

  async function broadcastClientDiagnosticWithAck(
    category: string,
    details: Record<string, unknown>,
  ): Promise<boolean> {
    const code = liveCodeRef.current;
    const ws = liveWsRef.current;
    if (
      !code ||
      !broadcasterJoinedRef.current ||
      !ws ||
      ws.readyState !== WebSocket.OPEN
    ) {
      return false;
    }
    const diagnosticId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        diagnosticAckResolversRef.current.delete(diagnosticId);
        resolve(false);
      }, 2_000);
      diagnosticAckResolversRef.current.set(diagnosticId, () => {
        clearTimeout(timeout);
        diagnosticAckResolversRef.current.delete(diagnosticId);
        resolve(true);
      });
      ws.send(JSON.stringify({
        type: 'client-diagnostic',
        code,
        category,
        details,
        diagnosticId,
      }));
    });
  }

  function broadcastVideoModeWhenJoined(
    code: string,
    hasVideo: boolean,
    videoMode: 'webrtc' | 'mjpeg' | 'none' = hasVideo ? 'webrtc' : 'none',
  ) {
    if (!broadcasterJoinedRef.current) {
      pendingVideoModeRef.current = { code, hasVideo, videoMode };
      const ws = liveWsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'join-broadcaster',
          code,
          authToken: broadcasterTokenRef.current,
          teamScore: latestScoresRef.current.teamScore,
          opponentScore: latestScoresRef.current.opponentScore,
          hasVideo,
          videoMode,
          videoTransportError: liveVideoTransportErrorRef.current,
        }));
      }
      return;
    }
    pendingVideoModeRef.current = null;
    broadcastWsSend({
      type: 'join-broadcaster',
      code,
      authToken: broadcasterTokenRef.current,
      hasVideo,
      videoMode,
      videoTransportError: liveVideoTransportErrorRef.current,
    });
  }

  function connectBroadcasterWs(code: string, initTeamScore: number, initOppScore: number) {
    const sessionGeneration = ++liveSessionGenerationRef.current;
    broadcasterJoinedRef.current = false;
    pendingVideoModeRef.current = null;
    pendingClientDiagnosticsRef.current =
      pendingClientDiagnosticsRef.current.filter((entry) => entry.code === code);
    // A reconnect is a new signaling session. Stale peer attempts/callbacks
    // must not remain attached to the replacement WebSocket.
    closeAllWebRtcPeers();
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
      if (liveSessionGenerationRef.current !== sessionGeneration) return;
      const pendingMode = pendingVideoModeRef.current;
      if (
        sharedCameraMode &&
        !pendingMode &&
        !mjpegFallbackActiveRef.current &&
        !webrtcStreamRef.current &&
        !webrtcCameraFailedRef.current
      ) {
        // MJPEG startup is still unresolved. Do not publish a false score-only
        // state merely because the signaling socket opened first. The native
        // success or terminal-failure path will send the authoritative initial
        // join through broadcastVideoModeWhenJoined.
        return;
      }
      // Shared camera video is never advertised optimistically. Its optional
      // patched bridge is discovered lazily, so only an already-created stream
      // proves video is available. Stream creation sends a second authoritative
      // join-broadcaster with hasVideo=true and then drains queued viewers.
      const cameraFailed = webrtcCameraFailedRef.current;
      // RTCPeerConnection is null when running in Expo Go (native module unavailable)
      const webrtcSupported = RTCPeerConnection !== null;
      const hasCameraPermission = sharedCameraMode
        ? hoopsCameraPermission?.camera === 'granted'
        : !!cameraPermission?.granted;
      const hasVideo = pendingMode?.code === code
        ? pendingMode.hasVideo
        : sharedCameraMode
        ? (mjpegFallbackActiveRef.current || !!webrtcStreamRef.current) && !cameraFailed
        : webrtcSupported && !cameraFailed && hasCameraPermission;
      const videoMode = pendingMode?.code === code
        ? pendingMode.videoMode
        : hasVideo
        ? (mjpegFallbackActiveRef.current ? 'mjpeg' : 'webrtc')
        : 'none';
      ws.send(JSON.stringify({
        type: 'join-broadcaster',
        code,
        authToken: broadcasterTokenRef.current,
        teamScore: initTeamScore,
        opponentScore: initOppScore,
        hasVideo,
        videoMode,
        videoTransportError: liveVideoTransportErrorRef.current,
      }));
    };

    ws.onmessage = async (event: MessageEvent) => {
      try {
        if (liveSessionGenerationRef.current !== sessionGeneration) return;
        const msg = JSON.parse(event.data as string);
        if (msg.type === 'broadcaster-joined') {
          broadcasterJoinedRef.current = true;
          const pendingMode = pendingVideoModeRef.current;
          if (pendingMode?.code === code) {
            broadcastVideoModeWhenJoined(
              pendingMode.code,
              pendingMode.hasVideo,
              pendingMode.videoMode,
            );
          }
          const diagnostics = pendingClientDiagnosticsRef.current
            .filter((diagnostic) => diagnostic.code === code);
          pendingClientDiagnosticsRef.current = [];
          for (const diagnostic of diagnostics) {
            broadcastWsSend({
              type: 'client-diagnostic',
              code,
              category: diagnostic.category,
              details: diagnostic.details,
            });
          }
        } else if (msg.type === 'client-diagnostic-received') {
          const resolve = diagnosticAckResolversRef.current.get(msg.diagnosticId);
          resolve?.();
        } else if (msg.type === 'new-viewer') {
          if (mjpegFallbackActiveRef.current) return;
          // A record-enabled game intentionally advertises score-only mode.
          // Do not queue viewer IDs for an offer that can never be created.
          if (webrtcCameraFailedRef.current) return;
          if (webrtcStreamRef.current) {
            // Stream is ready — offer immediately.
            await createPeerForViewer(msg.viewerId, code, sessionGeneration);
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
      if (liveSessionGenerationRef.current !== sessionGeneration) return;
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
    // Changing AVFoundation inputs while an iPad is actively writing a video
    // has caused native app termination. Preserve the recording rather than
    // trying to split and reconfigure the session mid-game.
    if (isRecording && isTablet) {
      Alert.alert(
        'Camera is recording',
        'Finish this game before switching cameras. This keeps the iPad recording stable.',
      );
      return;
    }
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
            void stopCameraRecording();
            const activeRecording = recordingPromiseRef.current;
            if (activeRecording) {
              const watchdog = setTimeout(() => {
                showCameraNotice('Finalizing recording… camera switch will continue when the clip is safe.');
              }, 3_000);
              try {
                // Never reconfigure the native camera until AVFoundation has
                // returned the authoritative URI. The watchdog is feedback
                // only and cannot turn a still-recording clip into undefined.
                const result = await activeRecording;
                addRecordedUri(result?.uri);
              } catch { /* recording stopped cleanly */ }
              finally { clearTimeout(watchdog); }
            }
            // Invalidate the old session and reset even if iPad's native
            // recording promise did not settle after stopRecording().
            recordingGenerationRef.current += 1;
            recordingStartedRef.current = false;
            recordingPromiseRef.current = null;
            setIsRecording(false);
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
      if (sharedCameraMode) {
        try {
          const permission = await requestHoopsCameraPermissionsAsync();
          setHoopsCameraPermission(permission);
        } catch (error) {
          console.warn('[HoopsCamera] permission request failed:', error);
          setHoopsCameraPermission(null);
        }
        return;
      }
      if (!cameraPermission?.granted) await requestCameraPermission();
      if (!micPermission?.granted) await requestMicPermission();
    })();
  }, [recordVideo, sharedCameraMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // HoopsCamera controls the movie output's audio connection directly, so
  // mute/unmute never opens a second capture session or interrupts video.
  useEffect(() => {
    if (!sharedCameraMode) return;
    void setHoopsCameraMicrophoneMutedAsync(micMuted).catch((error) => {
      console.warn('[HoopsCamera] microphone mute update failed:', error);
    });
  }, [sharedCameraMode, micMuted]);

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

  async function stopCameraRecording(): Promise<void> {
    stopVideoTimelineSegment(videoTimelineClockRef.current);
    if (!sharedCameraMode) {
      cameraRef.current?.stopRecording();
      return;
    }

    // HoopsCamera resolves startRecordingAsync when AVFoundation finalizes
    // the movie, while stopRecordingAsync is the explicit stop request. The
    // watchdog is feedback only: it must never settle
    // recordingPromiseRef with an invented/undefined URI.
    const completion = recordingCompletionRef.current;
    const stopRequest = stopHoopsCameraRecordingAsync();
    stopRequest
      .then((recording) => {
        if (recording?.uri) completion?.resolve(recording);
      })
      .catch((error) => completion?.reject(error));
    try {
      await Promise.race([
        stopRequest,
        new Promise<undefined>((resolve) => setTimeout(resolve, 3_000)),
      ]);
    } catch (error) {
      // The recording promise is rejected above as well. Keep this request
      // helper non-throwing so the save/flip path can await the authoritative
      // recordingPromiseRef and retain its existing recovery behavior.
      console.warn('[HoopsCamera] stop request failed:', error);
    }
  }

  function clearRecordingRecoveryWatchdog() {
    if (recordingRecoveryWatchdogRef.current) {
      clearTimeout(recordingRecoveryWatchdogRef.current);
      recordingRecoveryWatchdogRef.current = null;
    }
  }

  async function pauseForRecordingFailure(reason: string) {
    if (
      recordingFailureRecoveryRef.current ||
      recordingTerminalIntentRef.current
    ) return;
    recordingFailureRecoveryRef.current = true;
    clearRecordingRecoveryWatchdog();
    setCameraRecoveryBlocked(true);
    setRunning(false);
    setIsRecording(false);
    pendingClockStartRef.current = false;
    recordingDesiredRef.current = false;
    unexpectedRecordingResumePendingRef.current = false;
    broadcastClientDiagnostic('recording-recovery-timeout', { reason });

    // A missing native "recording" event is ambiguous: capture may have
    // started even though JS never received confirmation. Stop/finalize that
    // possible segment before clearing refs so the next Play tap cannot overlap
    // an active AVCaptureMovieFileOutput.
    const staleCompletion = recordingPromiseRef.current;
    recordingGenerationRef.current += 1;
    try {
      const stopped = await Promise.race([
        stopHoopsCameraRecordingAsync().catch(() => undefined),
        new Promise<undefined>((resolve) => setTimeout(resolve, 3_000)),
      ]);
      addRecordedUri(stopped?.uri);
      if (staleCompletion) {
        const finalized = await Promise.race([
          staleCompletion.catch(() => undefined),
          new Promise<undefined>((resolve) => setTimeout(resolve, 500)),
        ]);
        addRecordedUri(finalized?.uri);
      }
    } finally {
      recordingStartedRef.current = false;
      nativeRecordingActiveRef.current = false;
      recordingPromiseRef.current = null;
      recordingCompletionRef.current = null;
      recordingFailureRecoveryRef.current = false;
      setCameraRecoveryBlocked(false);
    }
    Alert.alert(
      'Recording paused',
      'The camera stopped and did not recover. The game clock was paused so no more action is recorded without video. Tap Play to resume recording.',
    );
  }

  function armRecordingRecoveryWatchdog(reason: string) {
    // Preserve one fixed deadline across native restart retries. Re-arming on
    // every rejected attempt would let an endless retry loop keep the game
    // clock running forever without confirmed video.
    if (recordingRecoveryWatchdogRef.current) return;
    recordingRecoveryWatchdogRef.current = setTimeout(() => {
      recordingRecoveryWatchdogRef.current = null;
      if (
        nativeRecordingActiveRef.current ||
        !recordingDesiredRef.current ||
        recordingTerminalIntentRef.current
      ) return;
      void pauseForRecordingFailure(reason);
    }, 5_000);
  }

  async function settleRecordingForSave(): Promise<void> {
    if (recordingStartedRef.current) {
      await stopCameraRecording();
    }
    const pendingRecording = recordingPromiseRef.current;
    if (pendingRecording) {
      try {
        const result = await pendingRecording;
        addRecordedUri(result?.uri);
      } catch {
        // A failed interrupted segment cannot contribute a URI, but all
        // previously finalized segments remain in recordedUrisRef.
      }
    }
    recordingStartedRef.current = false;
    recordingPromiseRef.current = null;
    recordingCompletionRef.current = null;
    setIsRecording(false);
  }

  async function startRecording() {
    if (dailyLiveRef.current) return;
    if (
      recordingTerminalIntentRef.current ||
      isSharingLiveLinkRef.current ||
      (!sharedCameraMode && !cameraRef.current) ||
      recordingStartedRef.current
    ) return;
    const hasRecordingPermission = sharedCameraMode
      ? hoopsCameraPermission?.camera === 'granted' &&
        hoopsCameraPermission?.microphone === 'granted'
      : !!cameraPermission?.granted && !!micPermission?.granted;
    if (!hasRecordingPermission) return;
    // Older camera stacks cannot reliably service expo-camera recording and
    // react-native-webrtc capture at the same time. Trying to keep both
    // sessions open can wedge the camera service; the compiled HoopsCamera
    // pipeline is explicitly designed to share them and must stay open.
    if (webrtcStreamRef.current && !sharedCameraMode) {
      webrtcCameraFailedRef.current = true;
      closeAllWebRtcPeers();
      stopWebRtcStream();
      if (liveCode) {
        broadcastVideoModeWhenJoined(liveCode, false);
      }
    }
    recordingStartedRef.current = true;
    recordingDesiredRef.current = true;
    nativeRecordingActiveRef.current = false;
    if (sharedCameraMode) {
      armRecordingRecoveryWatchdog('recording-start');
    }
    if (!sharedCameraMode) {
      startVideoTimelineSegment(videoTimelineClockRef.current);
    }
    const myGen = ++recordingGenerationRef.current;
    // Native modal presentation over CameraView can interrupt AVFoundation on
    // iPad. Recording always wins: close any prepared invite sheet first.
    setShowGoLiveSheet(false);
    setIsRecording(true);
    try {
      if (sharedCameraMode) {
        let resolveCompletion!: (recording: { uri: string } | undefined) => void;
        let rejectCompletion!: (error: unknown) => void;
        const completion = new Promise<{ uri: string } | undefined>((resolve, reject) => {
          resolveCompletion = resolve;
          rejectCompletion = reject;
        });
        recordingCompletionRef.current = {
          resolve: resolveCompletion,
          reject: rejectCompletion,
        };
        recordingPromiseRef.current = completion;
        // The native start promise intentionally remains pending until
        // stopRecordingAsync has finalized the movie.
        void startHoopsCameraRecordingAsync(micMuted)
          .then(resolveCompletion)
          .catch(rejectCompletion);
      } else {
        recordingPromiseRef.current = cameraRef.current.recordAsync({ mute: micMuted } as any) as Promise<{ uri: string } | undefined>;
      }
      const result = await recordingPromiseRef.current;
      addRecordedUri(result?.uri);
      if (myGen === recordingGenerationRef.current) {
        recordingStartedRef.current = false;
        recordingPromiseRef.current = null;
        recordingCompletionRef.current = null;
        // HoopsCamera emits a timestamped recording-finished event; that event
        // owns its exact timeline boundary. Legacy CameraView has no matching
        // event, so close its timeline as soon as recordAsync resolves.
        if (!sharedCameraMode) {
          stopVideoTimelineSegment(videoTimelineClockRef.current);
          recordingDesiredRef.current = false;
        }
      }
    } catch (err: any) {
      const shouldRetryRecoveredRecording =
        sharedCameraMode &&
        unexpectedRecordingResumePendingRef.current &&
        recordingDesiredRef.current &&
        !recordingTerminalIntentRef.current;
      const shouldPauseForFailedStart =
        sharedCameraMode &&
        recordingDesiredRef.current &&
        !recordingTerminalIntentRef.current &&
        !lifecycleInterruptedRef.current &&
        !shouldRetryRecoveredRecording;
      if (myGen === recordingGenerationRef.current) {
        stopVideoTimelineSegment(videoTimelineClockRef.current);
        // Error on this specific session (not superseded by a camera flip)
        recordingStartedRef.current = false;
        if (
          !lifecycleInterruptedRef.current &&
          !shouldRetryRecoveredRecording &&
          !shouldPauseForFailedStart
        ) {
          recordingDesiredRef.current = false;
        }
        recordingPromiseRef.current = null;
        recordingCompletionRef.current = null;
      }
      console.warn('Camera recording ended:', err?.message);
      if (shouldPauseForFailedStart) {
        void pauseForRecordingFailure('recording-start-failed');
      } else if (shouldRetryRecoveredRecording) {
        setTimeout(() => {
          if (
            unexpectedRecordingResumePendingRef.current &&
            recordingDesiredRef.current &&
            !recordingTerminalIntentRef.current &&
            !recordingStartedRef.current
          ) {
            void startRecordingRef.current?.();
          }
        }, 1_000);
      }
    } finally {
      // Only update isRecording if a newer recording session hasn't already taken over
      if (myGen === recordingGenerationRef.current) {
        setIsRecording(false);
        recordingCompletionRef.current = null;
      }
    }
  }
  startRecordingRef.current = startRecording;

  function onCameraReady() {
    cameraReadyRef.current = true;
    if (
      pendingRecordRef.current &&
      !recordingStartedRef.current &&
      !isSharingLiveLinkRef.current
    ) {
      pendingRecordRef.current = false;
      startRecording();
    }
  }

  // The native session is authoritative for lifecycle interruption. Do not
  // infer recording pauses from AppState: iPadOS can background the JS surface
  // while AVFoundation is still finalizing the interrupted movie.
  useEffect(() => {
    if (!sharedCameraMode) return;
    const maybeResumeRecording = () => {
      if (
        !lifecycleResumePendingRef.current ||
        !lifecycleFinalizedRef.current ||
        !recordingDesiredRef.current ||
        recordingTerminalIntentRef.current ||
        recordingStartedRef.current
      ) return;
      lifecycleResumePendingRef.current = false;
      lifecycleInterruptedRef.current = false;
      void startRecordingRef.current?.();
    };
    const stateSubscription = addHoopsCameraListener('onStateChange', (event) => {
      broadcastClientDiagnostic('camera-state', {
        state: event.state,
        reason: event.reason ?? '',
        isRecording: event.isRecording,
      });
      const isSessionInterruption =
        event.state === 'paused' &&
        event.reason?.startsWith('session-interruption-');
      if (isSessionInterruption) {
        nativeRecordingActiveRef.current = false;
        stopVideoTimelineSegment(videoTimelineClockRef.current, event.timestampMs);
        setIsRecording(false);
        setRunning((wasRunning) => {
          if (wasRunning) pendingClockStartRef.current = true;
          return false;
        });
      }
      if (
        event.state === 'previewing' &&
        unexpectedRecordingResumePendingRef.current &&
        recordingDesiredRef.current &&
        !recordingTerminalIntentRef.current
      ) {
        setTimeout(() => void startRecordingRef.current?.(), 100);
      }
      if (event.state === 'recording' && recordingDesiredRef.current) {
        nativeRecordingActiveRef.current = true;
        clearRecordingRecoveryWatchdog();
        unexpectedRecordingResumePendingRef.current = false;
        startVideoTimelineSegment(videoTimelineClockRef.current, event.timestampMs);
        if (
          pendingClockStartRef.current &&
          !recordingTerminalIntentRef.current
        ) {
          pendingClockStartRef.current = false;
          startRef.current = Date.now();
          setRunning(true);
        }
      }
      if (event.reason !== 'lifecycle-interruption') return;
      lifecycleInterruptedRef.current = true;
      lifecycleFinalizedRef.current = false;
      lifecycleResumePendingRef.current = false;
      recordingStartedRef.current = false;
      nativeRecordingActiveRef.current = false;
      pendingRecordRef.current = false;
      stopVideoTimelineSegment(videoTimelineClockRef.current, event.timestampMs);
      setIsRecording(false);
    });
    const finishedSubscription = addHoopsCameraListener('onRecordingFinished', (event) => {
      const diagnosticDetails = {
        usable: event.usable ?? false,
        reason: event.reason ?? '',
        durationSeconds: event.durationSeconds ?? 0,
        fileSizeBytes: event.fileSizeBytes ?? 0,
        error: event.error ?? '',
      };
      broadcastClientDiagnostic('recording-finished', diagnosticDetails);
      recordingFinishedForSaveRef.current?.(diagnosticDetails);
      addRecordedUri(event.uri);
      recordingStartedRef.current = false;
      nativeRecordingActiveRef.current = false;
      stopVideoTimelineSegment(videoTimelineClockRef.current, event.timestampMs);
      if (event.reason === 'lifecycle') {
        lifecycleInterruptedRef.current = true;
        lifecycleFinalizedRef.current = true;
      } else if (
        (event.reason === 'unexpected' ||
          event.reason === 'session-interruption' ||
          event.reason === 'runtime-error') &&
        recordingDesiredRef.current &&
        !recordingTerminalIntentRef.current
      ) {
        unexpectedRecordingResumePendingRef.current = true;
        armRecordingRecoveryWatchdog(event.reason);
        // A plain movie-output stop can leave the capture session running, so
        // there may be no later "previewing" event to trigger recovery.
        setTimeout(() => {
          if (
            unexpectedRecordingResumePendingRef.current &&
            recordingDesiredRef.current &&
            !recordingTerminalIntentRef.current
          ) {
            void startRecordingRef.current?.();
          }
        }, 350);
      } else if (!recordingTerminalIntentRef.current) {
        recordingDesiredRef.current = false;
      }
      // Do not settle the mutable completion ref from this event. Native
      // resolves the exact segment's start promise before emitting the event;
      // a delayed old event must never resolve a newer recording segment.
      maybeResumeRecording();
    });
    const resumeSubscription = addHoopsCameraListener('onLifecycleResume', (event) => {
      // JS may have been suspended before pause/finalization events crossed
      // the bridge. Restore from the native checkpoint carried on foreground.
      if (event.interruptionId) {
        lifecycleInterruptedRef.current = true;
        lifecycleFinalizedRef.current = event.finalizationComplete === true;
        recordingStartedRef.current = false;
        pendingRecordRef.current = false;
        addRecordedUri(event.finalizedUri);
        stopVideoTimelineSegment(videoTimelineClockRef.current, event.interruptedAtMs);
        setIsRecording(false);
      }
      if (!lifecycleInterruptedRef.current) return;
      const interruptionId = event.interruptionId ?? 'unknown';
      if (lifecycleResumeHandledRef.current === interruptionId) return;
      lifecycleResumeHandledRef.current = interruptionId;
      lifecycleResumePendingRef.current = true;
      closeAllWebRtcPeers();
      stopWebRtcStream();
      setLiveMediaRecoveryGeneration((generation) => generation + 1);
      maybeResumeRecording();
    });
    return () => {
      clearRecordingRecoveryWatchdog();
      stateSubscription.remove();
      finishedSubscription.remove();
      resumeSubscription.remove();
    };
  }, [sharedCameraMode]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleStartStop() {
    if (!running) {
      if (pendingClockStartRef.current) return;
      if (isSharingLiveLinkRef.current) {
        Alert.alert(
          'Sharing in progress',
          'Return to StecStats and wait for the camera before starting the game.',
        );
        return;
      }
      if (cameraRecoveryBlocked) {
        Alert.alert(
          'Camera unavailable',
          'The camera did not recover after Messages. Close and reopen StecStats before recording this game.',
        );
        return;
      }
      setGameStarted(true);
      if (dailyLiveRef.current) {
        if (seconds === 0) startRef.current = Date.now();
        setRunning(true);
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        return;
      }
      if (
        recordVideo &&
        sharedCameraMode &&
        !nativeRecordingActiveRef.current
      ) {
        // Never let the game clock get ahead of the master recording. Sharing
        // the Live link can leave AVCaptureSession recovering for several
        // seconds, so wait for the authoritative native "recording" event.
        pendingClockStartRef.current = true;
        recordingDesiredRef.current = true;
        armRecordingRecoveryWatchdog('camera-start-confirmation');
        if (cameraReadyRef.current) {
          void startRecording();
        } else {
          pendingRecordRef.current = true;
        }
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        return;
      }
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
      pendingClockStartRef.current = false;
      setRunning(false);
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  }

  function eventVideoTimestampMs() {
    // Stats-only games retain the game-clock timestamp for compatibility even
    // though no reel will consume it. Recorded games use only finalized/in-
    // progress movie time so every tagged play maps onto the uploaded video.
    return dailyLiveRef.current
      ? dailyRecordingElapsedMs()
      : recordVideo
      ? readVideoTimelineMs(videoTimelineClockRef.current)
      : running ? Date.now() - startRef.current : seconds * 1000;
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
    const ts = eventVideoTimestampMs();
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
    const ts = eventVideoTimestampMs();
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
  const hasGameActivity =
    gameStarted ||
    seconds > 0 ||
    events.length > 0 ||
    teamScore !== 0 ||
    opponentScore !== 0;

  // ─── WebRTC camera stream — opened when live, closed when done ──────────────
  useEffect(() => {
    const mediaGeneration = ++liveMediaGenerationRef.current;
    let cancelled = false;
    const isCurrentMedia = () =>
      !cancelled && liveMediaGenerationRef.current === mediaGeneration;

    // Reset the camera-failed flag whenever broadcast state changes so that a
    // fresh go-live starts optimistically ('pending'), not stuck on a prior failure.
    webrtcCameraFailedRef.current = false;

    const hasCameraPermission = sharedCameraMode
      ? hoopsCameraPermission?.camera === 'granted'
      : !!cameraPermission?.granted;
    if (dailyLiveRef.current || dailyLive || !isLive || !liveCode || !hasCameraPermission) {
      stopMjpegFallback();
      closeAllWebRtcPeers();
      stopWebRtcStream();
      return;
    }
    // Older binaries retain the conservative score-only behavior while local
    // recording is active. HoopsCamera's compiled iOS pipeline is the
    // exception: it exposes the existing capture session as a WebRTC video
    // track, so viewers can receive video while recording continues.
    if (recordVideo && !sharedCameraMode) {
      webrtcCameraFailedRef.current = true;
      closeAllWebRtcPeers();
      stopWebRtcStream();
      broadcastVideoModeWhenJoined(liveCode, false);
      return;
    }
    // HoopsCameraView applies facing changes to the existing native session.
    // Do not tear down a shared viewer stream just because that prop changed
    // (notably while a recording is being split for a phone camera flip).
    if (mjpegFallbackActiveRef.current) {
      return;
    }
    if (sharedCameraMode && webrtcStreamRef.current && sharedStreamSessionRef.current === liveCode) {
      return;
    }
    if (sharedCameraMode && webrtcStreamRef.current) {
      closeAllWebRtcPeers();
      stopWebRtcStream();
    }
    (async () => {
      try {
        let stream: any;
        if (sharedCameraMode) {
          // Do not call getUserMedia with video here: that would create a
          // second camera capturer and defeat the shared native pipeline.
          const liveVideo = await createHoopsCameraLiveVideoAsync();
          const nativeFrameCount = await waitForHoopsCameraLiveVideoFramesAsync();
          broadcastClientDiagnostic('live-video-native-ready', {
            nativeFrameCount,
            trackId: liveVideo.track.id,
            trackEnabled: liveVideo.track.enabled,
            trackReadyState: liveVideo.track.readyState,
          });
          stream = liveVideo.stream;
          if (!isCurrentMedia()) {
            await releaseHoopsCameraLiveVideoAsync().catch(() => undefined);
            return;
          }
          webrtcStreamRef.current = stream;
          sharedStreamSessionRef.current = liveCode;

          // Audio is deliberately isolated from camera acquisition and is
          // launched without delaying video readiness or queued-viewer
          // draining. A denied microphone/device degrades to video-only.
          if (mediaDevices?.getUserMedia) {
            void (async () => {
              try {
                const audioStream = await mediaDevices.getUserMedia({ audio: true, video: false });
                if (!isCurrentMedia()) {
                  audioStream?.getTracks?.().forEach((track: any) => track.stop());
                  return;
                }
                webrtcAudioStreamRef.current = audioStream;
              } catch (audioError) {
                if (isCurrentMedia()) {
                  console.warn('[WebRTC] shared live audio unavailable — using video-only:', audioError);
                }
              }
            })();
          }
        } else {
          if (!mediaDevices) return; // native module not available (Expo Go)
          stream = await mediaDevices.getUserMedia({
            video: { facingMode: cameraFacing === 'back' ? 'environment' : 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: true,
          });
        }
        if (isCurrentMedia()) {
          webrtcStreamRef.current = stream;
          broadcastVideoModeWhenJoined(liveCode, true);

          // Watch for the camera track ending unexpectedly (iOS thermal throttle,
          // AVFoundation session conflict with expo-camera, or system preemption).
          // Switch viewers to score-only mode so the broadcast can continue
          // without the frozen camera preview requiring a force-quit.
          const videoTrack = stream.getVideoTracks?.()[0];
          if (videoTrack) {
            (videoTrack as any).addEventListener?.('ended', () => {
              // Ignore callbacks from a superseded stream while retaining the
              // listener across shared-camera facing updates.
              if (webrtcStreamRef.current !== stream) return;
              console.warn('[WebRTC] Camera track ended unexpectedly — switching to MJPEG');
              webrtcCameraFailedRef.current = true;
              liveMediaGenerationRef.current += 1;
              // Close all peer connections — they can no longer send video.
              closeAllWebRtcPeers();
              stopWebRtcStream();
              void startMjpegFallback(liveCode, 'shared-track-ended');
            });
          }

          // Offer any viewers who arrived while the stream was opening.
          drainPendingViewers(
            pendingViewerIdsRef.current,
            stream,
            (id) => createPeerForViewer(id, liveCode!, liveSessionGenerationRef.current),
          );
        }
      } catch (e) {
        if (sharedCameraMode) {
          await releaseHoopsCameraLiveVideoAsync().catch(() => undefined);
        }
        console.warn(`[WebRTC] ${sharedCameraMode ? 'HoopsCamera video stream' : 'getUserMedia'} failed — viewers will see score-only:`, e);
        broadcastClientDiagnostic('live-video-failed', {
          sharedCameraMode,
          message: e instanceof Error ? e.message : String(e),
        });
        if (isCurrentMedia()) {
          // Mark the failure so ws.onopen sends the authoritative score-only
          // mode when the socket hasn't opened yet (race: getUserMedia rejected
          // before onopen fired). If the socket is already open, broadcastWsSend
          // immediately notifies the server to push session-mode to viewers.
          webrtcCameraFailedRef.current = true;
          void startMjpegFallback(liveCode, 'shared-stream-failed');
        }
      }
    })();
    return () => {
      cancelled = true;
      pendingViewerIdsRef.current = [];
      // Keep the shared stream and peers alive across a native facing update;
      // all other lifecycle changes still release them below.
      if (!(sharedCameraMode && isLive && liveCode && sharedStreamSessionRef.current === liveCode)) {
        closeAllWebRtcPeers();
        stopWebRtcStream();
      }
    };
  }, [isLive, dailyLive, liveCode, cameraPermission?.granted, hoopsCameraPermission?.camera, cameraFacing, recordVideo, sharedCameraMode, liveMediaRecoveryGeneration]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Live scoreboard push — fires whenever score changes while broadcasting ──
  useEffect(() => {
    latestScoresRef.current = { teamScore, opponentScore };
    if (!isLive || !liveCode) return;
    broadcastWsSend({ type: 'scoreboard', code: liveCode, teamScore, opponentScore });
  }, [teamScore, opponentScore, isLive, liveCode]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Cleanup broadcaster WS on unmount ───────────────────────────────────
  useEffect(() => {
    return () => {
      liveWsIntentionalCloseRef.current = true;
      liveSessionGenerationRef.current += 1;
      liveMediaGenerationRef.current += 1;
      if (liveWsReconnectRef.current) clearTimeout(liveWsReconnectRef.current);
      liveWsRef.current?.close();
      closeAllWebRtcPeers();
      stopWebRtcStream();
      stopMjpegFallback();
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

  useEffect(() => {
    if (
      saving ||
      uploadRetryGeneration === handledUploadRetryGenerationRef.current
    ) return;
    handledUploadRetryGenerationRef.current = uploadRetryGeneration;
    void retryFinalizedSave();
  }, [saving, uploadRetryGeneration]); // eslint-disable-line react-hooks/exhaustive-deps

  const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
    ? `https://${process.env.EXPO_PUBLIC_DOMAIN}`
    : '';

  // ── Connectivity state ─────────────────────────────────────────────────────
  // NetInfo uses native network-change notifications (and its web equivalent),
  // avoiding periodic HTTP work while the camera is recording. Queue recovery
  // remains owned app-wide by useOfflineQueueSync in _layout.tsx.
  useEffect(() => {
    return NetInfo.addEventListener((state) => {
      // Preserve the last known value while NetInfo is still determining the
      // connection. A connected transport counts as online unless NetInfo has
      // positively determined that the internet is unreachable.
      if (state.isConnected === null) return;
      const online = state.isConnected && state.isInternetReachable !== false;
      isOnlineRef.current = online;
      setIsOnline(online);
    });
  }, []);

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
    if (saving || recordingTerminalIntentRef.current) return;
    if (!players || (players as any[]).length === 0) {
      Alert.alert('No players', 'Add players to your team before saving a game.');
      return;
    }
    const ownsPendingMasterLease = recordVideo && tryAcquirePendingMasterLease();
    if (recordVideo && !ownsPendingMasterLease) {
      Alert.alert('Recording is still finishing', 'Please wait a moment, then tap End Game again.');
      return;
    }
    try {
      await saveWithPendingMasterLease();
    } finally {
      if (ownsPendingMasterLease) releasePendingMasterLease();
    }
  }

  async function retryFinalizedSave() {
    if (saving) return;
    const ownsPendingMasterLease = recordVideo && tryAcquirePendingMasterLease();
    if (recordVideo && !ownsPendingMasterLease) {
      Alert.alert('Upload is still finishing', 'Please wait a moment, then retry the upload.');
      return;
    }
    try {
      await saveWithPendingMasterLease();
    } finally {
      if (ownsPendingMasterLease) releasePendingMasterLease();
    }
  }

  async function saveWithPendingMasterLease() {
    // Latch terminal intent before any asynchronous stop/finalization work.
    // A didBecomeActive callback already queued by native recovery must never
    // create another segment after End Game begins.
    recordingTerminalIntentRef.current = true;
    pendingClockStartRef.current = false;
    recordingDesiredRef.current = false;
    unexpectedRecordingResumePendingRef.current = false;
    pendingRecordRef.current = false;

    if (dailyLiveRef.current) {
      setDailyProcessing(true);
      dailyRecordingCodeRef.current = liveCodeRef.current;
      // Daily is stopped before stats are persisted. The recording remains in
      // Daily Cloud; doSaveGame attaches it after the game row is committed.
      dailyRecordingRef.current = await stopDailyBroadcast().catch(() => null);
      dailyLiveRef.current = false;
      setDailyLive(false);
    } else if (recordVideo) {
      // Remove all CPU/GPU-heavy Live media before AVFoundation writes the
      // movie trailer, but retain the signaling socket for the final result.
      liveMediaGenerationRef.current += 1;
      closeAllWebRtcPeers();
      stopWebRtcStream();
      await stopMjpegFallback();
      const expectsFinishedEvent =
        recordingStartedRef.current || recordingPromiseRef.current !== null;
      let resolveFinishedEvent!: (details: Record<string, unknown> | null) => void;
      const finishedEvent = new Promise<Record<string, unknown> | null>((resolve) => {
        resolveFinishedEvent = resolve;
      });
      if (expectsFinishedEvent) {
        recordingFinishedForSaveRef.current = resolveFinishedEvent;
      }
      await settleRecordingForSave();
      let finalRecordingDetails: Record<string, unknown> | null = null;
      if (expectsFinishedEvent) {
        finalRecordingDetails = await Promise.race([
          finishedEvent,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_000)),
        ]);
        recordingFinishedForSaveRef.current = null;
      }
      if (finalRecordingDetails && liveCodeRef.current) {
        await broadcastClientDiagnosticWithAck(
          'recording-finalized-for-save',
          finalRecordingDetails,
        );
      }
    }

    // End any active broadcast after finalization so viewers get the final
    // score and the server receives the native recording result first.
    const activeLiveCode = liveCodeRef.current ?? liveCode;
    if (activeLiveCode) {
      await stopLiveBroadcast(activeLiveCode);
    }

    // ── Offline shortcut ───────────────────────────────────────────────────
    // When there's no network, skip video upload entirely and queue the game
    // locally.  Video requires a working upload connection so we offer
    // stats-only or cancellation.
    if (!isOnlineRef.current) {
      if (recordVideo && recordedUrisRef.current.length > 0) {
        const clientId = generateClientId();
        try {
          await AsyncStorage.setItem(PENDING_UPLOAD_KEY, JSON.stringify({
            uris: recordedUrisRef.current,
            teamId: Number(teamId), teamName: teamName as string,
            opponent: opponent as string, date: date as string,
            teamScore, opponentScore, stats, events, clientId,
            savedAt: new Date().toISOString(),
          } satisfies PendingUpload));
          await clearDraft();
          Alert.alert('Game saved for upload', 'Your full-game recording is safely queued and will upload automatically on cellular or Wi-Fi.', [
            { text: 'OK', onPress: () => router.replace('/(tabs)/games' as any) },
          ]);
        } catch {
          Alert.alert('Could not save recording', 'Storage could not save this recording for retry. Keep this screen open and try End Game again.');
        }
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
      let pendingClientId: string | undefined;
      // Daily owns the master during a Daily Live session. There will be no
      // local URI to upload; save the game with its live session code so the
      // server can attach the finalized cloud recording.
      if (recordVideo && !dailyRecordingCodeRef.current) {
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
          const clientId = generateClientId();
          pendingClientId = clientId;
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
            clientId,
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
            await updatePendingMasterUpload({ uploadedPaths });
          }

          if (attemptToken.cancelled) return;

          if (uploadedPaths.length === 1) {
            videoObjectPath = uploadedPaths[0];
            setUploadProgress(100);
          } else {
            // Multiple clips from camera flips or native session recovery are
            // concatenated server-side. The longer timeout covers full games
            // made from many interruption checkpoints.
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
          await updatePendingMasterUpload({ uploadedPaths, videoObjectPath: videoObjectPath! });

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
      await doSaveGame(videoObjectPath, pendingClientId);
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
      liveSessionCode: dailyRecordingCodeRef.current ?? undefined,
      queuedAt: new Date().toISOString(),
    });
    await clearDraft();
    // A recorded master has its own durable upload marker. Never delete it
    // while queuing stats after a network failure.
    if (!recordVideo) await AsyncStorage.removeItem(PENDING_UPLOAD_KEY).catch(() => {});
  }

  async function doSaveGame(videoObjectPath: string | null, existingClientId?: string) {
    // Generate ONE stable ID for this entire save attempt.  The same ID is:
    //   • sent in the online POST body so the server stores it as client_game_id
    //   • used by onNetworkFailure when queuing locally after a dropped response
    //   • used by the offline-only path below
    // This ensures a retry of a queued game finds the already-created server row
    // via ON CONFLICT DO NOTHING instead of inserting a duplicate.
    // If a coach elects to save stats while a recorded master is pending, use
    // the marker's same idempotency key. The recovery worker's POST then finds
    // this exact game and PATCH attaches the master rather than making a twin.
    let markerClientId: string | undefined;
    if (recordVideo && !videoObjectPath && !existingClientId) {
      try {
        markerClientId = (JSON.parse(await AsyncStorage.getItem(PENDING_UPLOAD_KEY) ?? '{}') as PendingUpload).clientId;
      } catch { /* preserve the normal new-game fallback */ }
    }
    const saveClientId = existingClientId ?? markerClientId ?? generateClientId();
    const liveSessionCode = dailyRecordingCodeRef.current ?? undefined;

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
      liveSessionCode,
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
      // Both server endpoints are idempotent: a retry sees an existing
      // processing job instead of creating a duplicate.  This runs only after
      // create-game confirms the master is attached.
      onVideoAttached: async (gameId) => {
        if (!videoObjectPath) return;
        // Keep the just-finalized native movie available after navigation.
        // One continuous local file can play immediately while the uploaded
        // copy is still being optimized; multi-segment games use the merged
        // server copy so Film Room never presents only part of the game.
        if (recordedUrisRef.current.length === 1) {
          await rememberLocalGameVideo(gameId, recordedUrisRef.current[0]).catch(() => {});
        }
        // Durable foreground transition: a crash after server linkage but
        // before navigation leaves the worker with the exact game/path.
        await updatePendingMasterUpload({ gameId, videoObjectPath });
        const token = await getToken();
        const headers = {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        };
        const responses = await Promise.all([
          fetch(`${API_BASE}/api/games/${gameId}/highlight`, { method: 'POST', headers, body: '{}' }),
          fetch(`${API_BASE}/api/games/${gameId}/lowlight`, { method: 'POST', headers, body: '{}' }),
        ]);
        // A video attachment is the durability boundary. Generation can be
        // requested independently by Film Room if a non-network server error
        // prevents a particular reel from starting.
        void responses;
      },
      onSaveSuccess: async () => {
        dailyRecordingRef.current = null;
        dailyRecordingCodeRef.current = null;
        dailyCredentialsRef.current = null;
        setDailyProcessing(false);
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
        {
          text: 'Retry upload',
          style: 'default',
          onPress: () => {
            // The state-backed generation guarantees a new render even though
            // saving was already cleared before this alert action runs.
            setUploadRetryGeneration((generation) => generation + 1);
          },
        },
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
  const isTablet = Math.min(sw, sh) >= 600;

  const styles = makeStyles(colors, insets, sw, sh, isLandscape);
  const cameraReady = recordVideo && !dailyLive && (
    sharedCameraMode
      ? hoopsCameraPermission?.camera === 'granted' && hoopsCameraPermission?.microphone === 'granted'
      : cameraPermission?.granted && micPermission?.granted
  );
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
                          <Text style={[styles.compactUndoBtnText, { color: colors.mutedForeground }]}>UNDO{'\n'}MAKE</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={() => handleShoot('undoMiss', s.madeKey as any, s.attKey as any, s.statField)}
                          disabled={!hasMiss}
                          activeOpacity={0.7}
                          style={[styles.compactUndoBtn, { borderColor: colors.border, opacity: hasMiss ? 1 : 0.3 }]}
                        >
                          <Text style={[styles.compactUndoBtnText, { color: colors.mutedForeground }]}>UNDO{'\n'}MISS</Text>
                        </TouchableOpacity>
                      </View>
                    );
                  })}
                </View>
              </View>

              {/* Counting stats: larger 3-over-2 grid on landscape tablets */}
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
        ) : !hasGameActivity ? (
          <TouchableOpacity
            onPress={handleStartStop}
            activeOpacity={0.8}
            style={[styles.saveBtn, { backgroundColor: colors.primary }]}
            testID="start-game-footer"
          >
            <Ionicons name="play-circle" size={20} color="#fff" />
            <Text style={styles.saveBtnText}>Start Game</Text>
          </TouchableOpacity>
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
      supportedOrientations={['portrait', 'landscape']}
      onDismiss={sharePendingLiveLink}
      onRequestClose={() => setShowGoLiveSheet(false)}
    >
      <View style={styles.sheetBackdrop}>
        <View style={[styles.sheetContainer, { backgroundColor: colors.card, borderColor: colors.border }]}>
          {/* Header */}
          <View style={styles.sheetHeader}>
            <View style={styles.sheetTitleRow}>
              <Animated.View style={[styles.sheetLiveDot, { opacity: livePulse }]} />
              <Text style={[styles.sheetTitle, { color: colors.foreground }]}>
                {isLive ? "You're Live" : 'Share Before Going Live'}
              </Text>
            </View>
            <TouchableOpacity onPress={() => setShowGoLiveSheet(false)} style={styles.sheetCloseBtn}>
              <Ionicons name="close" size={20} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>

          <Text style={[styles.sheetSub, { color: colors.mutedForeground }]}>
            {isLive
              ? 'The broadcast is shared through an unlisted YouTube stream. Anyone with this StecStats watch link can watch without an account.'
              : 'Send this watch link first. When you start Live, StecStats shares an unlisted YouTube stream that anyone with the link can watch without an account.'}
          </Text>

          {/* Session code */}
          <View style={[styles.codeBox, { backgroundColor: colors.muted, borderColor: colors.border }]}>
            <Text style={[styles.codeLabel, { color: colors.mutedForeground }]}>Session code</Text>
            <Text style={[styles.codeValue, { color: colors.foreground }]}>{liveCode}</Text>
            <Text
              selectable
              numberOfLines={1}
              style={[styles.watchAddress, { color: colors.primary }]}
            >
              {watchUrl(liveCode)}
            </Text>
          </View>

          {/* Share link */}
          <TouchableOpacity
            onPress={() => shareLiveLink(liveCode)}
            activeOpacity={0.8}
            style={styles.shareLinkBtn}
          >
            <LinearGradient
              colors={[colors.primary, colors.card, colors.background]}
              locations={[0, 0.68, 1]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.glossyButtonFill}
            >
              <LinearGradient
                pointerEvents="none"
                colors={['rgba(255,255,255,0.24)', 'rgba(255,255,255,0.04)', 'rgba(255,255,255,0)']}
                locations={[0, 0.38, 0.72]}
                style={StyleSheet.absoluteFillObject}
              />
              <Ionicons name="share-outline" size={18} color="#fff" />
              <Text style={styles.shareLinkText}>
                {isSharingLiveLink ? 'Opening Messages…' : 'Text Watch Link'}
              </Text>
            </LinearGradient>
          </TouchableOpacity>

          {!isLive && (
            <TouchableOpacity
              onPress={() => void activateLiveBroadcast(liveCode, dailyCredentialsRef.current ?? undefined)}
              activeOpacity={0.8}
              style={[styles.stopLiveBtn, { borderColor: colors.primary + '60' }]}
            >
              <Ionicons name="radio-outline" size={16} color={colors.primary} />
              <Text style={[styles.stopLiveText, { color: colors.primary }]}>Start Live Now</Text>
            </TouchableOpacity>
          )}

          {/* Stop broadcast / cancel prepared invite */}
          <TouchableOpacity
            onPress={async () => {
              setShowGoLiveSheet(false);
              await stopLiveBroadcast(liveCode);
            }}
            activeOpacity={0.8}
            style={[styles.stopLiveBtn, { borderColor: colors.destructive + '60' }]}
          >
            <Ionicons name="stop-circle-outline" size={18} color={colors.destructive} />
            <Text style={[styles.stopLiveText, { color: colors.destructive }]}>
              {isLive ? 'End Broadcast' : 'Cancel Invite'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  ) : null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
    <View
      ref={sharePresentationAnchorRef}
      style={[styles.root, recordVideo && isLandscape && styles.rootLandscape]}
    >
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
        {/* Daily owns the camera during Live; show its local track instead of
            the separate recording preview, which must stay inactive. */}
        {dailyLive ? (
          dailyLocalVideoTrack && DailyMediaView ? (
            <View pointerEvents="none" style={StyleSheet.absoluteFillObject}>
              <DailyMediaView
                videoTrack={dailyLocalVideoTrack}
                audioTrack={null}
                mirror={false}
                zOrder={0}
                objectFit="cover"
                style={StyleSheet.absoluteFillObject}
              />
            </View>
          ) : (
            <View pointerEvents="none" style={[StyleSheet.absoluteFillObject, styles.centered]}>
              <ActivityIndicator color="#ff5722" />
              <Text style={styles.dailyCameraStarting}>Starting live camera…</Text>
            </View>
          )
        ) : (
          <RecordingCameraPreview
            cameraRef={cameraRef}
            sharedCameraMode={sharedCameraMode}
            cameraActive={!isSharingLiveLink || recordingStartedRef.current || isRecording}
            cameraReady={!!cameraReady}
            cameraFacing={cameraFacing}
            cameraZoom={cameraZoom}
            containerWidth={cameraContainerSize.w}
            containerHeight={cameraContainerSize.h}
            isLandscape={isLandscape}
            onCameraReady={onCameraReady}
          />
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
                {isLive && (isRecording ? (
                  <View style={styles.liveBadge}>
                    <Animated.View style={[styles.liveDot, { opacity: livePulse }]} />
                    <Text style={styles.liveText}>{dailyLive ? 'LIVE · CLOUD REC' : 'LIVE · REC SAFE'}</Text>
                  </View>
                ) : (
                  <TouchableOpacity onPress={() => setShowGoLiveSheet(true)} style={styles.liveBadge} activeOpacity={0.8}>
                    <Animated.View style={[styles.liveDot, { opacity: livePulse }]} />
                    <Text style={styles.liveText}>LIVE</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
            {(dailyLive || dailyProcessing) && (
              <View style={styles.dailyStatusBanner}>
                <ActivityIndicator size="small" color="#fff" />
                <Text style={styles.dailyStatusText}>
                  {dailyProcessing ? 'Saving game — processing cloud recording…' : 'Live video is recording in the cloud'}
                </Text>
              </View>
            )}

            {/* Camera controls — top-left */}
            {(cameraReady || dailyLive) && (
              <View style={styles.camControls}>
                {/* Flip front/back — always enabled; prompts to save clip while recording */}
                <TouchableOpacity
                  onPress={() => {
                    if (dailyLive) {
                      void cycleDailyCamera()
                        .then((facing) => {
                          if (facing) setCameraFacing(facing);
                          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                        })
                        .catch((error) => {
                          Alert.alert('Camera switch failed', error instanceof Error ? error.message : 'Could not switch cameras.');
                        });
                      return;
                    }
                    toggleCameraFacing();
                  }}
                  activeOpacity={0.75}
                  style={[
                    styles.camControlBtn,
                    isRecording && isTablet && { opacity: 0.4 },
                  ]}
                >
                  <Ionicons name="camera-reverse" size={isTablet ? 24 : 18} color="#fff" />
                </TouchableOpacity>

                {/* Mute / unmute mic */}
                <TouchableOpacity
                  onPress={() => {
                    if (!dailyLive && isRecording && isTablet) {
                      Alert.alert('Recording in progress', 'Microphone settings apply when the next recording starts.');
                      return;
                    }
                    const nextMuted = !micMuted;
                    setMicMuted(nextMuted);
                    if (dailyLive) setDailyMicrophoneMuted(nextMuted);
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  }}
                  activeOpacity={0.75}
                  style={[
                    styles.camControlBtn,
                    micMuted && { backgroundColor: 'rgba(239,68,68,0.75)' },
                    !dailyLive && isRecording && isTablet && { opacity: 0.4 },
                  ]}
                >
                  <Ionicons name={micMuted ? 'mic-off' : 'mic'} size={isTablet ? 24 : 18} color="#fff" />
                </TouchableOpacity>

                {/* Phone-only layout override. iPads follow the device so the
                    native camera and recording metadata stay in sync. */}
                {!isTablet && <TouchableOpacity
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
                </TouchableOpacity>}

                {/* Dismiss preview */}
                <TouchableOpacity
                  onPress={togglePreview}
                  activeOpacity={0.75}
                  style={styles.camControlBtn}
                >
                  <Ionicons name="eye-off" size={isTablet ? 24 : 18} color="#fff" />
                </TouchableOpacity>

                {/* Go Live / Live indicator */}
                <TouchableOpacity
                  onPress={() => {
                    if (recordingStartedRef.current || isRecording) {
                      showCameraNotice(
                        isLive
                          ? 'Live video is active. Share the link after recording.'
                          : 'Recording protected — start Live before recording.',
                      );
                      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
                      return;
                    }
                    if (isLive) {
                      setShowGoLiveSheet(true);
                    } else {
                      startLiveBroadcast();
                    }
                  }}
                  activeOpacity={0.75}
                  disabled={liveLoading}
                  style={[
                    styles.camControlBtn,
                    isLive && { backgroundColor: 'rgba(239,68,68,0.85)' },
                    isRecording && { opacity: 0.48 },
                  ]}
                >
                  {liveLoading ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : isRecording && !isLive ? (
                    <Ionicons name="lock-closed" size={isTablet ? 23 : 17} color="#fff" />
                  ) : isLive ? (
                    <Ionicons name="radio" size={isTablet ? 24 : 18} color="#fff" />
                  ) : (
                    <Ionicons name="radio-outline" size={isTablet ? 24 : 18} color="#fff" />
                  )}
                </TouchableOpacity>
              </View>
            )}

            {cameraReady && !dailyLive && (
              <View style={styles.zoomControls}>
                <TouchableOpacity
                  testID="camera-zoom-out"
                  accessibilityRole="button"
                  accessibilityLabel="Zoom camera out"
                  disabled={cameraZoom <= 0}
                  onPress={() => adjustCameraZoom(-CAMERA_ZOOM_STEP)}
                  activeOpacity={0.75}
                  style={[styles.zoomControlBtn, cameraZoom <= 0 && styles.zoomControlBtnDisabled]}
                >
                  <Ionicons name="remove" size={22} color="#fff" />
                </TouchableOpacity>
                <View style={styles.zoomControlLevel}>
                  <Text style={styles.zoomControlLevelText}>{(1 + cameraZoom * 4).toFixed(1)}×</Text>
                </View>
                <TouchableOpacity
                  testID="camera-zoom-in"
                  accessibilityRole="button"
                  accessibilityLabel="Zoom camera in"
                  disabled={cameraZoom >= 1}
                  onPress={() => adjustCameraZoom(CAMERA_ZOOM_STEP)}
                  activeOpacity={0.75}
                  style={[styles.zoomControlBtn, cameraZoom >= 1 && styles.zoomControlBtnDisabled]}
                >
                  <Ionicons name="add" size={22} color="#fff" />
                </TouchableOpacity>
              </View>
            )}

            {/* Permission denied — shown inside camera box */}
            {recordVideo && !dailyLive && !cameraReady && (
              <View style={styles.permBanner}>
                <Ionicons name="videocam-off" size={15} color="rgba(255,255,255,0.6)" />
                <Text style={styles.permText}>Camera permission needed</Text>
                <TouchableOpacity
                  onPress={async () => {
                    if (sharedCameraMode) {
                      try {
                        setHoopsCameraPermission(await requestHoopsCameraPermissionsAsync());
                      } catch {
                        setHoopsCameraPermission(null);
                      }
                    } else {
                      await requestCameraPermission();
                      await requestMicPermission();
                    }
                  }}
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
              <View style={styles.collapsedLiveBadge}>
                <Animated.View style={[styles.liveDot, { opacity: livePulse }]} />
                <Text style={styles.liveText}>{isRecording ? 'LIVE · REC SAFE' : 'LIVE'}</Text>
              </View>
            )}

            {recordVideo && isRecording && !isLive && (
              <View style={styles.recDotSmallRight}>
                <View style={styles.recDotSmall} />
                <Text style={styles.recDotSmallLabel}>REC</Text>
              </View>
            )}
          </View>
        )}

        {/* ── Zoom level badge — fades in after pinch or button adjustment ── */}
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
        {cameraNotice && (
          <View pointerEvents="none" style={styles.cameraNotice}>
            <Ionicons name="shield-checkmark" size={16} color="#fff" />
            <Text style={styles.cameraNoticeText}>{cameraNotice}</Text>
          </View>
        )}
      </View>
      </GestureDetector>

      {/* ── STATS SECTION (bottom half portrait / right half landscape) ── */}
      <View style={[styles.statsSection, recordVideo && isLandscape && styles.statsSectionLand]}>
        {statArea}
      </View>
    </View>
    </GestureHandlerRootView>
  );
}

function makeStyles(colors: any, insets: any, sw: number, sh: number, isLandscape: boolean) {
  // Camera section height — bigger on tablet.
  // Portrait: recording gets most of the screen on tablets.
  // Landscape: tablet gets 70 % width, phone gets 55 %.
  // Tablet detection: iPads (and large Android tablets) report at least 768px on
  // their short edge. Platform.isPad only exists on the iOS static type, so we
  // use a dimension heuristic that works cross-platform.
  const shortEdge = Math.min(sw, sh);
  const isTablet = shortEdge >= 768;
  const isTabletLandscape = isTablet && isLandscape;
  // Small phones (iPhone SE, etc.) have a screen height ≤ 667 pt.  At 54 % the
  // camera alone takes ~360 pt, leaving only ~307 pt for the chip bar, stat
  // buttons, and Save button — too cramped.  Drop back to 46 % on those devices
  // so the controls section keeps the same space it had before the height bump.
  // Larger phones (≥ 750 pt) and tablets keep the 54 % / 62 % values.
  const isSmallPhone = !isTablet && sh <= 667;
  const portraitRatio = isTablet ? 0.70 : isSmallPhone ? 0.46 : 0.54;
  const cameraH = isLandscape ? sh : Math.round(sh * portraitRatio);
  const cameraLandW = isTablet ? '62%' : '55%';

  return StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    rootLandscape: { flexDirection: 'row' },
    centered: { alignItems: 'center', justifyContent: 'center' },
    dailyCameraStarting: {
      marginTop: 10,
      color: 'rgba(255,255,255,0.72)',
      fontFamily: 'Inter_500Medium',
      fontSize: 13,
    },

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
      paddingTop: isTabletLandscape ? 12 : 8,
      paddingBottom: isTabletLandscape ? 16 : 10,
      paddingHorizontal: isTabletLandscape ? 18 : 10,
      backgroundColor: 'rgba(0,0,0,0.52)',
      zIndex: 30,
      elevation: 30,
    },
    closeBtn: { alignSelf: 'center', padding: 4, marginBottom: 2 },
    scoreboard: { flexDirection: 'row', alignItems: 'center' },
    scoreCol: { flex: 1, alignItems: 'center' },
    teamLabel: {
      fontSize: isTabletLandscape ? 16 : 11, textTransform: 'uppercase', letterSpacing: 0.5,
      marginBottom: 1, fontFamily: 'Inter_500Medium',
      color: 'rgba(255,255,255,0.7)', maxWidth: isTabletLandscape ? 180 : 110,
    },
    scoreNum: { ...tekoStyle(isTabletLandscape ? 62 : 44), color: '#fff' },
    scoreCenter: { alignItems: 'center', gap: isTabletLandscape ? 8 : 5, paddingHorizontal: isTabletLandscape ? 14 : 8 },
    timer: { ...tekoStyle(isTabletLandscape ? 30 : 20, 'regular'), color: 'rgba(255,255,255,0.75)' },
    timerBtn: { width: isTabletLandscape ? 44 : 30, height: isTabletLandscape ? 44 : 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
    halfBtn: {
      borderWidth: 1, borderRadius: 6,
      paddingHorizontal: isTabletLandscape ? 12 : 8, paddingVertical: isTabletLandscape ? 6 : 2,
      borderColor: 'rgba(255,255,255,0.3)',
    },
    halfText: { fontSize: isTabletLandscape ? 14 : 11, fontFamily: 'Inter_600SemiBold', color: 'rgba(255,255,255,0.75)' },
    oppScoreRow: {
      position: 'relative',
      zIndex: 31,
      elevation: 31,
      flexDirection: 'row',
      alignItems: 'center',
      gap: isTabletLandscape ? 8 : 5,
    },
    // Compact quick-buttons used inside the dark camera overlay (white-tinted)
    oppOverlayQuickBtn: {
      minWidth: isTabletLandscape ? 52 : undefined,
      height: isTabletLandscape ? 48 : undefined,
      paddingHorizontal: isTabletLandscape ? 12 : 7,
      paddingVertical: 3,
      borderRadius: 6,
      backgroundColor: 'rgba(255,255,255,0.18)',
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.35)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    oppOverlayQuickBtnText: {
      fontSize: isTabletLandscape ? 16 : 11,
      fontFamily: 'Inter_700Bold',
      color: '#fff',
      lineHeight: isTabletLandscape ? 20 : 14,
    },
    oppQuickBtn: {
      minWidth: isTabletLandscape ? 52 : undefined,
      height: isTabletLandscape ? 48 : undefined,
      paddingHorizontal: isTabletLandscape ? 12 : 7,
      paddingVertical: isTabletLandscape ? 8 : 4,
      borderRadius: 6,
      borderWidth: 1,
      alignItems: 'center',
      justifyContent: 'center',
    },
    oppQuickBtnText: {
      fontSize: isTabletLandscape ? 16 : 12,
      fontFamily: 'Inter_700Bold',
      lineHeight: isTabletLandscape ? 20 : 14,
    },
    oppBtn: {
      width: isTabletLandscape ? 48 : 40, height: isTabletLandscape ? 48 : 40, borderRadius: 10,
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
      paddingVertical: isTabletLandscape ? 12 : 8,
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
    oppScoreStripNum: { ...tekoStyle(isTabletLandscape ? 34 : 28) },
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
      left: isTabletLandscape ? 14 : 10,
      flexDirection: 'column',
      gap: isTabletLandscape ? 10 : 6,
      zIndex: 10,
    },
    cameraNotice: {
      position: 'absolute',
      top: 58,
      left: 14,
      right: 14,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderRadius: 12,
      backgroundColor: 'rgba(15,23,42,0.92)',
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.2)',
    },
    cameraNoticeText: {
      color: '#fff',
      fontSize: 12,
      lineHeight: 16,
      fontFamily: 'Inter_600SemiBold',
      textAlign: 'center',
    },
    camControlBtn: {
      width: isTabletLandscape ? 52 : 34,
      height: isTabletLandscape ? 52 : 34,
      borderRadius: isTabletLandscape ? 14 : 10,
      backgroundColor: 'rgba(0,0,0,0.55)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    zoomControls: {
      position: 'absolute',
      top: insets.top + (Platform.OS === 'web' ? 116 : 60),
      right: 10,
      alignItems: 'center',
      gap: 5,
    },
    zoomControlBtn: {
      width: 42,
      height: 42,
      borderRadius: 21,
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.32)',
      backgroundColor: 'rgba(0,0,0,0.62)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    zoomControlBtnDisabled: {
      opacity: 0.35,
    },
    zoomControlLevel: {
      minWidth: 42,
      paddingHorizontal: 6,
      paddingVertical: 4,
      borderRadius: 10,
      backgroundColor: 'rgba(0,0,0,0.62)',
      alignItems: 'center',
    },
    zoomControlLevelText: {
      color: '#fff',
      fontSize: 11,
      fontFamily: 'Inter_700Bold',
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
    dailyStatusBanner: {
      position: 'absolute',
      top: insets.top + (Platform.OS === 'web' ? 98 : 42),
      left: 12,
      right: 12,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      paddingVertical: 8,
      paddingHorizontal: 10,
      borderRadius: 8,
      backgroundColor: 'rgba(0,0,0,0.68)',
    },
    dailyStatusText: {
      color: '#fff',
      fontSize: 12,
      fontFamily: 'Inter_600SemiBold',
      textAlign: 'center',
    },

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
      paddingVertical: isTabletLandscape ? 10 : 6,
    },
    playerChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      minWidth: isTabletLandscape ? 100 : undefined,
      justifyContent: 'center',
      paddingHorizontal: isTabletLandscape ? 16 : 12,
      paddingVertical: isTabletLandscape ? 11 : 7,
      borderRadius: 20,
      borderWidth: 1,
    },
    playerChipName: { fontSize: isTabletLandscape ? 18 : 14, fontFamily: 'Inter_600SemiBold' },
    playerChipPts: { fontSize: isTabletLandscape ? 16 : 12, fontFamily: 'Inter_500Medium' },

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
      paddingHorizontal: isTabletLandscape ? 16 : 12,
      paddingVertical: isTabletLandscape ? 11 : 7,
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
      fontSize: isTabletLandscape ? 12 : 9,
      fontFamily: 'Inter_700Bold',
      letterSpacing: 1,
    },
    oppBarName: {
      fontSize: isTabletLandscape ? 17 : 14,
      fontFamily: 'Inter_600SemiBold',
      flexShrink: 1,
    },
    oppBarRight: {
      position: 'relative',
      zIndex: 30,
      elevation: 30,
      flexDirection: 'row',
      alignItems: 'center',
      gap: isTabletLandscape ? 8 : 4,
    },
    oppBarScore: {
      ...tekoStyle(isTabletLandscape ? 34 : 24),
      minWidth: isTabletLandscape ? 40 : 28,
      textAlign: 'center' as const,
    },

    // ── Compact stat area (camera recording mode) ─────────────────────────────
    compactStatArea: {
      flex: 1,
      paddingHorizontal: isTablet ? 5 : 8,
      paddingTop: isTablet ? 8 : 3,
      paddingBottom: isTablet ? 8 : 3,
      gap: isTabletLandscape ? 16 : (isTablet ? 12 : 5),
      justifyContent: isTabletLandscape ? 'space-evenly' : 'flex-start',
    },
    compactShootGrid: { gap: isTabletLandscape ? 16 : (isTablet ? 8 : 4) },
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
      fontSize: isTabletLandscape ? 12 : 10,
      fontFamily: 'Inter_700Bold',
      letterSpacing: 0.5,
      textTransform: 'uppercase' as const,
    },
    compactShootCount: {
      fontSize: isTabletLandscape ? 14 : 12,
      fontFamily: 'Inter_600SemiBold',
    },
    compactMakeBtn: {
      flex: 1,
      height: isTabletLandscape ? 70 : (isTablet ? 48 : 36),
      borderRadius: 9,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
    },
    compactMissBtn: {
      flex: 1,
      height: isTabletLandscape ? 70 : (isTablet ? 48 : 36),
      borderRadius: 9,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
    },
    compactActionBtnText: {
      fontSize: isTabletLandscape ? 13 : 10,
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
      height: isTabletLandscape ? 44 : (isTablet ? 36 : 24),
      borderRadius: 5,
      borderWidth: 1,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
    },
    compactUndoBtnText: {
      fontSize: isTabletLandscape ? 10 : (isTablet ? 9 : 7),
      lineHeight: isTabletLandscape ? 12 : (isTablet ? 11 : 9),
      textAlign: 'center',
      fontFamily: 'Inter_700Bold',
    },
    compactCountStrip: {
      flexDirection: 'row',
      flexWrap: isTabletLandscape ? 'wrap' : 'nowrap',
      gap: isTabletLandscape ? 8 : 4,
      minHeight: isTabletLandscape ? 220 : (isTablet ? 90 : undefined),
      marginTop: isTablet ? 4 : 0,
    },
    compactCountCard: {
      flexGrow: 1,
      flexBasis: isTabletLandscape ? '31%' : 0,
      borderRadius: 8,
      borderWidth: 1,
      padding: isTabletLandscape ? 10 : (isTablet ? 7 : 4),
      alignItems: 'center',
      justifyContent: 'center',
      gap: 2,
    },
    compactCountLabel: {
      fontSize: isTabletLandscape ? 11 : 9,
      fontFamily: 'Inter_700Bold',
      letterSpacing: 0.5,
      textTransform: 'uppercase' as const,
    },
    compactCountVal: { ...tekoStyle(isTabletLandscape ? 36 : (isTablet ? 22 : 16)) },
    compactCountBtns: { flexDirection: 'row', gap: 3, width: '100%' },
    compactCountBtn: {
      flex: 1,
      height: isTabletLandscape ? 42 : (isTablet ? 30 : 24),
      borderRadius: 6,
      alignItems: 'center',
      justifyContent: 'center',
    },
    compactCountBtnTxt: {
      fontSize: isTabletLandscape ? 16 : 12,
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
    watchAddress: {
      fontSize: 11,
      fontFamily: 'Inter_500Medium',
      marginTop: 6,
    },
    shareLinkBtn: {
      height: 48,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.primary + '80',
      overflow: 'hidden',
    },
    glossyButtonFill: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
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
