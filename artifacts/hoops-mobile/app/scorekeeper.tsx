import React, { useState, useRef, useEffect, useCallback } from 'react';
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
} from 'react-native';
import { useAuth } from '@clerk/clerk-expo';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { showNoVideoAlert } from '@/lib/noVideoAlert';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useListPlayers, useCreateGame, useRequestUploadUrl } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions, useMicrophonePermissions } from 'expo-camera';

interface StatLine {
  ftMade: number; ftAttempted: number;
  twoMade: number; twoAttempted: number;
  threeMade: number; threeAttempted: number;
  assists: number; rebounds: number;
  steals: number; turnovers: number; blocks: number;
}

interface GameEvent {
  playerId: number; statField: string; delta: number; videoTimestampMs: number;
}

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

const UPLOAD_CANCELLED_MSG = 'Upload cancelled';
/**
 * cancelToken is a per-attempt object `{ cancelled: boolean }` created fresh for
 * each handleSave() call.  The async stages close over this reference so they
 * check the flag of their own attempt — immune to resets by a subsequent attempt.
 */
async function uploadVideoFile(
  uri: string,
  requestUploadUrlFn: (body: { name: string; size: number; contentType: string }) => Promise<{ uploadURL: string; objectPath: string }>,
  onProgress?: (pct: number) => void,
  xhrRef?: React.MutableRefObject<XMLHttpRequest | null>,
  cancelToken?: { cancelled: boolean },
): Promise<string> {
  const fileResponse = await fetch(uri);
  const blob = await fileResponse.blob();
  // Check for cancellation after the potentially slow fetch+blob step.
  if (cancelToken?.cancelled) throw new Error(UPLOAD_CANCELLED_MSG);
  const contentType = uri.endsWith('.mov') ? 'video/quicktime' : 'video/mp4';
  const ext = uri.endsWith('.mov') ? 'mov' : 'mp4';
  const { uploadURL, objectPath } = await requestUploadUrlFn({
    name: `game-recording-${Date.now()}.${ext}`,
    size: blob.size || 1,
    contentType,
  });
  // Check again after the presign round-trip before opening the XHR.
  if (cancelToken?.cancelled) throw new Error(UPLOAD_CANCELLED_MSG);
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    if (xhrRef) xhrRef.current = xhr;
    // If cancel was requested between the check above and the XHR send, bail immediately.
    if (cancelToken?.cancelled) {
      if (xhrRef) xhrRef.current = null;
      reject(new Error(UPLOAD_CANCELLED_MSG));
      return;
    }
    xhr.open('PUT', uploadURL);
    xhr.setRequestHeader('Content-Type', contentType);

    // iOS WebKit can suppress or fire onprogress only once. Run a simulated
    // progress ticker so the bar always advances visibly. Real XHR events win
    // whenever they report a higher value; the ticker is cleared on completion.
    let reportedPct = 0;
    const TICK_MS = 300;
    // Asymptotic curve: each tick advances ~8 % of the remaining gap to 90 %.
    const CAP = 90;
    const simulatedTimer = onProgress
      ? setInterval(() => {
          if (reportedPct < CAP) {
            reportedPct = Math.min(CAP, reportedPct + Math.ceil((CAP - reportedPct) * 0.08));
            onProgress(reportedPct);
          }
        }, TICK_MS)
      : null;

    const finish = () => {
      if (simulatedTimer !== null) clearInterval(simulatedTimer);
      if (xhrRef) xhrRef.current = null;
    };

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        const real = Math.round((e.loaded / e.total) * 100);
        if (real > reportedPct) {
          reportedPct = real;
          onProgress(real);
        }
      }
    };
    xhr.onload = () => {
      finish();
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(100);
        resolve();
      } else {
        reject(new Error(`Video upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => { finish(); reject(new Error('Video upload failed (network error)')); };
    xhr.ontimeout = () => { finish(); reject(new Error('Video upload timed out')); };
    xhr.onabort = () => { finish(); reject(new Error(UPLOAD_CANCELLED_MSG)); };
    xhr.send(blob);
  });
  return objectPath;
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
  const [selectedPlayerId, setSelectedPlayerId] = useState<number | null>(null);
  const [stats, setStats] = useState<Record<number, StatLine>>({});
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [opponentScore, setOpponentScore] = useState(0);
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
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startRef = useRef<number>(0);

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
      recordingPromiseRef.current = cameraRef.current.recordAsync() as Promise<{ uri: string } | undefined>;
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
      return { ...prev, [selectedPlayerId]: { ...line, [madeKey]: nextMade, [attKey]: nextAtt } };
    });
    if (action === 'make') {
      setEvents((prev) => [...prev, { playerId: selectedPlayerId, statField, delta: 1, videoTimestampMs: ts }]);
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
    }
  }

  const teamScore = Object.values(stats).reduce((sum, line) => sum + calcPoints(line), 0);

  const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
    ? `https://${process.env.EXPO_PUBLIC_DOMAIN}`
    : '';

  async function handleSave() {
    if (saving) return;
    if (!players || (players as any[]).length === 0) {
      Alert.alert('No players', 'Add players to your team before saving a game.');
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
          showNoVideoAlert(recordingStartedRef.current, setSaving, saveGame);
          return;
        }

        try {
          const uris = recordedUrisRef.current;
          const uploadedPaths: string[] = [];

          setUploadProgress(0);
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
            );
            if (attemptToken.cancelled) return;
            uploadedPaths.push(p);
          }

          if (attemptToken.cancelled) return;

          if (uploadedPaths.length === 1) {
            videoObjectPath = uploadedPaths[0];
            setUploadProgress(100);
          } else {
            // Multiple clips from camera flips — concat server-side
            setUploadProgress(92);
            const token = await getToken();
            const concatRes = await fetch(`${API_BASE}/api/storage/concat-segments`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
              },
              body: JSON.stringify({ segmentPaths: uploadedPaths }),
            });
            if (!concatRes.ok) {
              const errBody = await concatRes.json().catch(() => ({}));
              throw new Error((errBody as any)?.error ?? `Concat failed (${concatRes.status})`);
            }
            const { videoObjectPath: merged } = await concatRes.json();
            videoObjectPath = merged;
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
              { text: 'Save without video', style: 'default', onPress: () => saveGame(null) },
            ],
          );
          return;
        }
      }
      await saveGame(videoObjectPath);
    } catch (err: any) {
      setUploadProgress(null);
      Alert.alert('Save failed', err?.message ?? 'Could not save game');
      setSaving(false);
    }
  }

  async function saveGame(videoObjectPath: string | null) {
    try {
      const statLines = (players as any[]).map((p) => {
        const line = stats[p.id] ?? defaultLine();
        return { playerId: p.id, ...line };
      });
      const result = teamScore > opponentScore ? 'W' : 'L';
      const game = await createGame.mutateAsync({
        data: {
          teamId: Number(teamId),
          opponent: opponent as string,
          date: date as string,
          result: result as 'W' | 'L',
          teamScore,
          opponentScore,
          stats: statLines,
          events,
          ...(videoObjectPath ? { videoObjectPath } : {}),
        },
      });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await qc.invalidateQueries({ queryKey: ['listTeamGames'] });
      router.replace(`/game/${game.id}`);
    } catch (err: any) {
      Alert.alert('Save failed', err?.message ?? 'Could not save game');
      setSaving(false);
    }
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
      'Your game stats are still saved. Would you like to save without the video?',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Save without video', style: 'default', onPress: () => saveGame(null) },
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
  const isLandscape = sw > sh;

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
      <TouchableOpacity onPress={() => router.back()} style={styles.closeBtn}>
        <Ionicons name="chevron-down" size={22} color="rgba(255,255,255,0.85)" />
      </TouchableOpacity>
      <View style={styles.scoreboard}>
        {/* Our score */}
        <View style={styles.scoreCol}>
          <Text style={styles.teamLabel} numberOfLines={1}>{teamName}</Text>
          <Text style={[styles.scoreNum, { fontFamily: 'Teko_700Bold' }]}>{teamScore}</Text>
        </View>

        {/* Center: timer + half */}
        <View style={styles.scoreCenter}>
          <Text style={[styles.timer, { fontFamily: 'Teko_400Regular' }]}>{formatTime(seconds)}</Text>
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

        {/* Opponent score */}
        <View style={styles.scoreCol}>
          <Text style={styles.teamLabel} numberOfLines={1}>{opponent}</Text>
          <View style={styles.oppScoreRow}>
            <TouchableOpacity
              onPress={() => { setOpponentScore((s) => Math.max(0, s - 1)); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
              style={styles.oppBtn}
            >
              <Text style={styles.oppBtnText}>−</Text>
            </TouchableOpacity>
            <Text style={[styles.scoreNum, { fontFamily: 'Teko_700Bold' }]}>{opponentScore}</Text>
            <TouchableOpacity
              onPress={() => { setOpponentScore((s) => s + 1); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
              style={styles.oppBtn}
            >
              <Text style={styles.oppBtnText}>+</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </View>
  );

  // ── Shared: stat area ──
  const statArea = (
    <>
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

      {/* Stat scroll */}
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
                    <Text style={[styles.shootValue, { color: colors.foreground, fontFamily: 'Teko_700Bold' }]}>
                      {made}/{att}
                    </Text>
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
                    <Text style={[styles.countValue, { color: accent, fontFamily: 'Teko_700Bold' }]}>{val}</Text>
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

      {/* Save button */}
      <View style={[styles.footer, { paddingBottom: insets.bottom + 16 }]}>
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

  return (
    <View style={[styles.root, isLandscape && styles.rootLandscape]}>

      {/* ── Compact scoreboard header — shown when not recording (camera hidden) ── */}
      {!recordVideo && (
        <View style={[styles.scoreHeader, { paddingTop: insets.top + (Platform.OS === 'ios' ? 8 : 24), backgroundColor: colors.card, borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={() => router.back()} style={styles.closeBtn}>
            <Ionicons name="chevron-down" size={22} color={colors.mutedForeground} />
          </TouchableOpacity>
          <View style={styles.scoreboard}>
            <View style={styles.scoreCol}>
              <Text style={[styles.teamLabel, { color: colors.mutedForeground }]} numberOfLines={1}>{teamName}</Text>
              <Text style={[styles.scoreNum, { fontFamily: 'Teko_700Bold', color: colors.foreground }]}>{teamScore}</Text>
            </View>
            <View style={styles.scoreCenter}>
              <Text style={[styles.timer, { fontFamily: 'Teko_400Regular', color: colors.foreground }]}>{formatTime(seconds)}</Text>
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
                >
                  <Text style={[styles.oppBtnText, { color: colors.foreground }]}>−</Text>
                </TouchableOpacity>
                <Text style={[styles.scoreNum, { fontFamily: 'Teko_700Bold', color: colors.foreground }]}>{opponentScore}</Text>
                <TouchableOpacity
                  onPress={() => { setOpponentScore((s) => s + 1); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
                  style={[styles.oppBtn, { backgroundColor: colors.muted }]}
                >
                  <Text style={[styles.oppBtnText, { color: colors.foreground }]}>+</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </View>
      )}

      {/* ── CAMERA SECTION (top half portrait / left half landscape) ── */}
      {/* Keep this View mounted so CameraView never unmounts mid-recording */}
      <View style={[
        isLandscape ? styles.cameraSectionLand : styles.cameraSectionPort,
        !previewVisible && styles.cameraSectionCollapsed,
        !recordVideo && styles.cameraSectionHidden,
      ]}>
        {/* Camera always mounted so recording is uninterrupted when preview is hidden */}
        {cameraReady ? (
          <CameraView
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
            facing={cameraFacing}
            mode="video"
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
              <View style={styles.recBadge}>
                {isRecording ? <View style={styles.recDot} /> : <Ionicons name="videocam" size={10} color="#fff" />}
                <Text style={styles.recText}>{isRecording ? 'REC' : 'CAM'}</Text>
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

                {/* Dismiss preview */}
                <TouchableOpacity
                  onPress={togglePreview}
                  activeOpacity={0.75}
                  style={styles.camControlBtn}
                >
                  <Ionicons name="eye-off" size={18} color="#fff" />
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
          /* Preview hidden — dark overlay with expand button */
          <View style={styles.previewHiddenOverlay}>
            <TouchableOpacity onPress={togglePreview} activeOpacity={0.75} style={styles.expandPreviewBtn}>
              <Ionicons name="videocam" size={16} color="#fff" />
            </TouchableOpacity>
            {recordVideo && isRecording && <View style={styles.recDotSmall} />}
          </View>
        )}
      </View>

      {/* ── STATS SECTION (bottom half portrait / right half landscape) ── */}
      <View style={[styles.statsSection, isLandscape && styles.statsSectionLand]}>
        {statArea}
      </View>
    </View>
  );
}

function makeStyles(colors: any, insets: any, sw: number, sh: number, isLandscape: boolean) {
  // Camera section height: top half in portrait, full height in landscape
  const cameraH = isLandscape ? sh : Math.round(sh * 0.46);

  return StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    rootLandscape: { flexDirection: 'row' },
    centered: { alignItems: 'center', justifyContent: 'center' },

    // ── Camera section ─────────────────────────────────────────────────────
    cameraSectionPort: {
      width: '100%',
      height: cameraH,
      backgroundColor: '#0d0d0d',
      overflow: 'hidden',
    },
    cameraSectionLand: {
      width: '48%',
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
    scoreNum: { fontSize: 44, lineHeight: 46, color: '#fff' },
    scoreCenter: { alignItems: 'center', gap: 5, paddingHorizontal: 8 },
    timer: { fontSize: 20, lineHeight: 22, color: 'rgba(255,255,255,0.75)' },
    timerBtn: { width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
    halfBtn: {
      borderWidth: 1, borderRadius: 6,
      paddingHorizontal: 8, paddingVertical: 2,
      borderColor: 'rgba(255,255,255,0.3)',
    },
    halfText: { fontSize: 11, fontFamily: 'Inter_600SemiBold', color: 'rgba(255,255,255,0.75)' },
    oppScoreRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    oppBtn: {
      width: 26, height: 26, borderRadius: 6,
      alignItems: 'center', justifyContent: 'center',
      backgroundColor: 'rgba(255,255,255,0.15)',
    },
    oppBtnText: { fontSize: 17, lineHeight: 19, fontFamily: 'Inter_600SemiBold', color: '#fff' },

    // Collapsed camera section (preview hidden)
    cameraSectionCollapsed: {
      height: 44,
      minHeight: 44,
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
      backgroundColor: 'rgba(0,0,0,0.85)',
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 10,
    },
    expandPreviewBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      backgroundColor: 'rgba(255,255,255,0.12)',
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 6,
    },
    recDotSmall: {
      width: 7,
      height: 7,
      borderRadius: 4,
      backgroundColor: '#EF4444',
    },

    // REC badge — top-right of camera section
    recBadge: {
      position: 'absolute',
      top: insets.top + (Platform.OS === 'web' ? 64 : 8),
      right: 10,
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
      paddingVertical: 9,
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
    shootValue: { fontSize: 20, lineHeight: 22 },
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
    countValue: { fontSize: 26, lineHeight: 28 },
    countBtns: { flexDirection: 'row', gap: 5, width: '100%' },
    countBtn: {
      flex: 1, height: 26, borderRadius: 8,
      alignItems: 'center', justifyContent: 'center',
    },
    countBtnText: { fontSize: 14, lineHeight: 16, fontFamily: 'Inter_700Bold' },

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
  });
}
