import React, { useMemo, useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  RefreshControl,
  Platform,
  Modal,
  Pressable,
  ScrollView,
  useWindowDimensions,
  Alert,
  Animated,
} from 'react-native';
import { Swipeable, GestureHandlerRootView } from 'react-native-gesture-handler';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LinearGradient } from 'expo-linear-gradient';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import { useListTeams, useListTeamGames, useListAllGames, useListPlayers, useCreateGame, useRequestUploadUrl, useDeleteGame } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@clerk/clerk-expo';
import { Ionicons, Feather } from '@expo/vector-icons';
import { tekoStyle } from '@/lib/tekoStyle';
import { uploadVideoFile } from '@/lib/uploadVideoFile';
import { saveGame } from '@/lib/saveGame';
import { generateClientId, loadQueuedGames, type QueuedGame } from '@/lib/offlineQueue';
import { PENDING_UPLOAD_KEY, type PendingUpload } from '@/app/scorekeeper';
import { ScreenGlow, BasketballWatermark } from '@/lib/ScreenBackground';

// ─── Pending upload recovery banner ────────────────────────────────────────
export function PendingUploadBanner({ onDismiss }: { onDismiss: () => void }) {
  const colors = useColors();
  const { getToken } = useAuth();
  const createGame = useCreateGame();
  const requestUploadUrl = useRequestUploadUrl();
  const qc = useQueryClient();
  const [pending, setPending] = useState<PendingUpload | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const cancelRef = useRef({ cancelled: false });

  useEffect(() => {
    AsyncStorage.getItem(PENDING_UPLOAD_KEY)
      .then((raw) => { if (raw) setPending(JSON.parse(raw) as PendingUpload); })
      .catch(() => {});
  }, []);

  if (!pending) return null;

  const gameDate = pending.date ? new Date(pending.date + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';

  async function handleRetryUpload() {
    if (!pending || uploading) return;
    setUploading(true);
    cancelRef.current = { cancelled: false };
    try {
      const uploadedPaths: string[] = [];
      const uris = pending.uris;
      setProgress(0);
      for (let i = 0; i < uris.length; i++) {
        const segStart = Math.round((i / uris.length) * 90);
        const segEnd   = Math.round(((i + 1) / uris.length) * 90);
        const path = await uploadVideoFile(
          uris[i],
          (body) => requestUploadUrl.mutateAsync({ data: body }),
          (pct) => setProgress(segStart + Math.round((pct / 100) * (segEnd - segStart))),
          xhrRef,
          cancelRef.current,
        );
        if (cancelRef.current.cancelled) return;
        uploadedPaths.push(path);
      }
      setProgress(95);

      let videoObjectPath = uploadedPaths[0];
      if (uploadedPaths.length > 1) {
        const token = await getToken();
        const domain = process.env.EXPO_PUBLIC_DOMAIN ? `https://${process.env.EXPO_PUBLIC_DOMAIN}` : '';
        const res = await fetch(`${domain}/api/storage/concat-segments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ segmentPaths: uploadedPaths }),
        });
        const { videoObjectPath: merged } = await res.json();
        videoObjectPath = merged;
      }

      setProgress(null);
      await saveGame(videoObjectPath, {
        players: Object.keys(pending.stats).map((id) => ({ id: Number(id) })),
        stats: pending.stats as any,
        teamScore: pending.teamScore,
        opponentScore: pending.opponentScore,
        teamId: pending.teamId,
        opponent: pending.opponent,
        date: pending.date,
        events: pending.events,
        clientId: generateClientId(),
        createGameMutateAsync: (args) => createGame.mutateAsync(args as any),
        invalidateQueries: (opts) => qc.invalidateQueries(opts),
        routerReplace: async () => {
          await AsyncStorage.removeItem(PENDING_UPLOAD_KEY).catch(() => {});
          setPending(null);
          onDismiss();
        },
        setSaving: setUploading,
      });
    } catch (err: any) {
      if (!cancelRef.current.cancelled) {
        Alert.alert('Upload failed', err?.message ?? 'Could not upload video. Try again or save without video.');
      }
      setProgress(null);
      setUploading(false);
    }
  }

  async function handleSaveWithoutVideo() {
    if (!pending || uploading) return;
    setUploading(true);
    await saveGame(null, {
      players: Object.keys(pending.stats).map((id) => ({ id: Number(id) })),
      stats: pending.stats as any,
      teamScore: pending.teamScore,
      opponentScore: pending.opponentScore,
      teamId: pending.teamId,
      opponent: pending.opponent,
      date: pending.date,
      events: pending.events,
      clientId: generateClientId(),
      createGameMutateAsync: (args) => createGame.mutateAsync(args as any),
      invalidateQueries: (opts) => qc.invalidateQueries(opts),
      routerReplace: async () => {
        await AsyncStorage.removeItem(PENDING_UPLOAD_KEY).catch(() => {});
        setPending(null);
        onDismiss();
      },
      setSaving: setUploading,
    });
  }

  async function handleDismiss() {
    Alert.alert(
      'Discard recording?',
      'This will delete the unsaved game and recording permanently.',
      [
        { text: 'Keep it', style: 'cancel' },
        {
          text: 'Discard', style: 'destructive',
          onPress: async () => {
            await AsyncStorage.removeItem(PENDING_UPLOAD_KEY).catch(() => {});
            setPending(null);
            onDismiss();
          },
        },
      ],
    );
  }

  return (
    <View style={{
      marginHorizontal: 16, marginBottom: 10, borderRadius: 12, overflow: 'hidden',
      borderWidth: 1, borderColor: 'rgba(255,83,26,0.4)',
      backgroundColor: 'rgba(255,83,26,0.10)',
    }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', padding: 12, gap: 10 }}>
        <Ionicons name="cloud-upload-outline" size={20} color={colors.primary} />
        <View style={{ flex: 1 }}>
          <Text style={{ color: colors.foreground, fontWeight: '600', fontSize: 13 }}>
            Unsaved recording
          </Text>
          <Text style={{ color: colors.mutedForeground, fontSize: 12, marginTop: 1 }}>
            {pending.teamName} vs {pending.opponent}{gameDate ? ` · ${gameDate}` : ''}{' '}
            · {pending.teamScore}–{pending.opponentScore}
          </Text>
        </View>
        {!uploading && (
          <TouchableOpacity onPress={handleDismiss} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="close" size={18} color={colors.mutedForeground} />
          </TouchableOpacity>
        )}
      </View>
      {progress !== null && (
        <View style={{ height: 3, backgroundColor: 'rgba(255,83,26,0.15)', marginHorizontal: 12, borderRadius: 2, marginBottom: 10 }}>
          <View style={{ height: 3, width: `${progress}%`, backgroundColor: colors.primary, borderRadius: 2 }} />
        </View>
      )}
      {!uploading ? (
        <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingBottom: 12 }}>
          <TouchableOpacity
            onPress={handleRetryUpload}
            style={{ flex: 1, backgroundColor: colors.primary, borderRadius: 8, paddingVertical: 8, alignItems: 'center' }}
          >
            <Text style={{ color: '#fff', fontWeight: '700', fontSize: 13 }}>Resume upload</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={handleSaveWithoutVideo}
            style={{ flex: 1, borderRadius: 8, paddingVertical: 8, alignItems: 'center', borderWidth: 1, borderColor: colors.border }}
          >
            <Text style={{ color: colors.mutedForeground, fontWeight: '600', fontSize: 13 }}>Save without video</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingBottom: 12 }}>
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={{ color: colors.mutedForeground, fontSize: 12 }}>
            {progress !== null ? `Uploading… ${progress}%` : 'Saving game…'}
          </Text>
        </View>
      )}
    </View>
  );
}

// ─── Glare overlays ────────────────────────────────────────────────────────
function GlareOverlay({ intensity = 0.08 }: { intensity?: number }) {
  return (
    <View style={StyleSheet.absoluteFillObject} pointerEvents="none">
      <LinearGradient
        colors={[`rgba(255,255,255,${intensity})`, 'rgba(255,255,255,0.0)']}
        start={{ x: 0.15, y: 0 }}
        end={{ x: 0.85, y: 0.75 }}
        style={{ flex: 1 }}
      />
    </View>
  );
}

function OrangeGlareOverlay({ strength = 1 }: { strength?: number }) {
  return (
    <View style={StyleSheet.absoluteFillObject} pointerEvents="none">
      <LinearGradient
        colors={[
          `rgba(255,83,26,${0.18 * strength})`,
          `rgba(255,140,60,${0.10 * strength})`,
          'rgba(255,255,255,0.0)',
        ]}
        locations={[0, 0.35, 1]}
        start={{ x: 0.1, y: 0 }}
        end={{ x: 0.9, y: 0.85 }}
        style={{ flex: 1 }}
      />
    </View>
  );
}

// ─── Season Picker Modal ───────────────────────────────────────────────────
function SeasonPickerModal({
  visible, teams, selectedIdx, onSelect, onClose, colors, insets,
}: {
  visible: boolean; teams: any[]; selectedIdx: number;
  onSelect: (i: number) => void; onClose: () => void; colors: any; insets: any;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={modalS.backdrop} onPress={onClose} />
      <View style={[modalS.sheet, { backgroundColor: colors.card, paddingBottom: insets.bottom + 16 }]}>
        <View style={[modalS.handle, { backgroundColor: colors.border }]} />
        <Text style={[modalS.title, { color: colors.foreground }]}>Choose Season</Text>
        <ScrollView showsVerticalScrollIndicator={false}>
          {/* "All Teams" option — shows every game across every team/season */}
          {(() => {
            const isSelected = selectedIdx === -1;
            return (
              <TouchableOpacity
                key="all"
                onPress={() => { onSelect(-1); onClose(); }}
                activeOpacity={0.7}
                style={[
                  modalS.row,
                  { borderColor: isSelected ? colors.primary : colors.border, backgroundColor: isSelected ? colors.primary + '18' : 'transparent', overflow: 'hidden' },
                ]}
              >
                {isSelected && <GlareOverlay intensity={0.10} />}
                <View style={modalS.rowLeft}>
                  <Text style={[modalS.teamName, { color: colors.foreground }]} numberOfLines={1}>All Teams</Text>
                  <Text style={[modalS.sport, { color: colors.mutedForeground }]}>Every game across all seasons</Text>
                </View>
                {isSelected && <Ionicons name="checkmark-circle" size={22} color={colors.primary} />}
              </TouchableOpacity>
            );
          })()}
          {teams.map((t, i) => {
            const isSelected = i === selectedIdx;
            return (
              <TouchableOpacity
                key={t.id}
                onPress={() => { onSelect(i); onClose(); }}
                activeOpacity={0.7}
                style={[
                  modalS.row,
                  { borderColor: isSelected ? colors.primary : colors.border, backgroundColor: isSelected ? colors.primary + '18' : 'transparent', overflow: 'hidden' },
                ]}
              >
                {isSelected && <GlareOverlay intensity={0.10} />}
                <View style={modalS.rowLeft}>
                  <Text style={[modalS.teamName, { color: colors.foreground }]} numberOfLines={1}>{t.name}</Text>
                  {t.sport && <Text style={[modalS.sport, { color: colors.mutedForeground }]}>{t.sport.charAt(0).toUpperCase() + t.sport.slice(1)}</Text>}
                </View>
                {isSelected && <Ionicons name="checkmark-circle" size={22} color={colors.primary} />}
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>
    </Modal>
  );
}

const modalS = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)' },
  sheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: 16, paddingTop: 12, maxHeight: '75%' },
  handle: { width: 36, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: 16 },
  title: { fontSize: 17, fontFamily: 'Inter_700Bold', marginBottom: 12, textAlign: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', borderRadius: 12, borderWidth: 1, paddingHorizontal: 16, paddingVertical: 14, marginBottom: 8 },
  rowLeft: { flex: 1 },
  teamName: { fontSize: 16, fontFamily: 'Inter_600SemiBold' },
  sport: { fontSize: 12, fontFamily: 'Inter_400Regular', marginTop: 2 },
});

// ─── Static styles shared by GameRow (can't use makeStyles outside screen) ──
const gameRowStyles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', borderRadius: 14, borderWidth: 1, marginBottom: 8 },
  datePill: { width: 56, alignItems: 'center', justifyContent: 'center', paddingVertical: 14, borderTopLeftRadius: 14, borderBottomLeftRadius: 14 },
  dateStr: { fontSize: 10, textTransform: 'uppercase', fontFamily: 'Inter_500Medium', letterSpacing: 0.5 },
  dateDay: { ...tekoStyle(30) },
  rowMid: { flex: 1, paddingHorizontal: 12, paddingVertical: 12 },
  opponent: { fontSize: 15, fontFamily: 'Inter_700Bold', marginBottom: 3 },
  score: { ...tekoStyle(15), letterSpacing: 0.3 },
  resultBadge: { width: 38, height: 38, borderRadius: 10, marginRight: 6, alignItems: 'center', justifyContent: 'center' },
  resultText: { ...tekoStyle(20), letterSpacing: 0.5 },
});

// ─── Game row delete action ──────────────────────────────────────────────────
function GameDeleteAction({ progress, onDelete, colors }: { progress: Animated.AnimatedInterpolation<number>; onDelete: () => void; colors: any }) {
  const trans = progress.interpolate({ inputRange: [0, 1], outputRange: [80, 0] });
  return (
    <Animated.View style={{ width: 80, justifyContent: 'center', alignItems: 'flex-end', transform: [{ translateX: trans }] }}>
      <TouchableOpacity
        onPress={onDelete}
        activeOpacity={0.8}
        style={{
          flex: 1,
          width: 80,
          alignItems: 'center',
          justifyContent: 'center',
          gap: 4,
          backgroundColor: colors.destructive,
          borderRadius: 10,
          marginBottom: 8,
          marginLeft: 4,
        }}
      >
        <Ionicons name="trash-outline" size={20} color="#fff" />
        <Text style={{ fontSize: 11, color: '#fff', fontFamily: 'Inter_600SemiBold' }}>Delete</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

// ─── Individual game row with swipe-to-delete ────────────────────────────────
function GameRow({ item, onDelete, colors, router }: { item: any; onDelete: (id: number, opponent: string) => void; colors: any; router: any }) {
  const swipeRef = useRef<Swipeable>(null);
  const isWin = item.result === 'W';
  const date = new Date(item.date);

  function handleDelete() {
    swipeRef.current?.close();
    onDelete(item.id, item.opponent);
  }

  return (
    <Swipeable
      ref={swipeRef}
      friction={2}
      overshootRight={false}
      renderRightActions={(progress) => (
        <GameDeleteAction progress={progress} onDelete={handleDelete} colors={colors} />
      )}
    >
      <TouchableOpacity
        onPress={() => router.push(`/game/${item.id}`)}
        onLongPress={handleDelete}
        delayLongPress={500}
        activeOpacity={0.7}
        style={[gameRowStyles.row, { backgroundColor: colors.card, borderColor: 'rgba(255,83,26,0.20)', overflow: 'hidden' }]}
      >
        <OrangeGlareOverlay strength={0.4} />
        <View style={[gameRowStyles.datePill, { backgroundColor: colors.muted }]}>
          <Text style={[gameRowStyles.dateStr, { color: colors.mutedForeground }]}>
            {date.toLocaleString('en', { month: 'short' })}
          </Text>
          <Text style={[gameRowStyles.dateDay, { color: colors.foreground }]}>
            {date.getDate()}
          </Text>
        </View>
        <View style={gameRowStyles.rowMid}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 3 }}>
            <Text style={[gameRowStyles.opponent, { color: colors.foreground, marginBottom: 0 }]} numberOfLines={1}>
              vs {item.opponent}
            </Text>
            {item.videoProcessing && (
              <View style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 3,
                backgroundColor: 'rgba(255,83,26,0.12)',
                borderRadius: 6,
                paddingHorizontal: 5,
                paddingVertical: 2,
              }}>
                <Ionicons name="time-outline" size={10} color={colors.primary} />
                <Text style={{ fontSize: 9, color: colors.primary, fontFamily: 'Inter_600SemiBold', letterSpacing: 0.3 }}>
                  Processing
                </Text>
              </View>
            )}
          </View>
          <Text style={[gameRowStyles.score, { color: colors.mutedForeground }]}>
            {item.teamScore} – {item.opponentScore}
          </Text>
        </View>
        <View style={[
          gameRowStyles.resultBadge,
          { backgroundColor: isWin ? 'rgba(255,83,26,0.22)' : colors.muted, overflow: 'hidden' },
        ]}>
          {isWin && <GlareOverlay intensity={0.18} />}
          <Text style={[gameRowStyles.resultText, { color: isWin ? colors.primary : colors.mutedForeground }]}>
            {isWin ? 'W' : 'L'}
          </Text>
        </View>
        <Feather name="chevron-right" size={15} color={colors.mutedForeground} style={{ marginRight: 12 }} />
      </TouchableOpacity>
    </Swipeable>
  );
}

// ─── Queued game box-score modal ─────────────────────────────────────────────
function QueuedGameBoxScoreModal({
  game,
  onClose,
  colors,
  insets,
}: {
  game: QueuedGame | null;
  onClose: () => void;
  colors: any;
  insets: any;
}) {
  if (!game) return null;

  const date = new Date(game.date + 'T12:00:00');
  const dateStr = date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

  return (
    <Modal visible={!!game} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.65)' }} onPress={onClose} />
      <View style={{
        backgroundColor: colors.card,
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        paddingHorizontal: 20,
        paddingTop: 16,
        paddingBottom: insets.bottom + 24,
        maxHeight: '80%',
      }}>
        {/* Handle */}
        <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: 'center', marginBottom: 16 }} />

        {/* Pending sync badge */}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginBottom: 12 }}>
          <Ionicons name="cloud-offline-outline" size={14} color={colors.mutedForeground} />
          <Text style={{ fontSize: 12, fontFamily: 'Inter_500Medium', color: colors.mutedForeground, letterSpacing: 0.3 }}>
            Pending sync · saved locally
          </Text>
        </View>

        {/* Score header */}
        <View style={{ alignItems: 'center', marginBottom: 4 }}>
          <Text style={{ ...tekoStyle(42), color: colors.foreground, letterSpacing: 1 }}>
            {game.teamScore} – {game.opponentScore}
          </Text>
          <Text style={{ fontSize: 13, fontFamily: 'Inter_600SemiBold', color: colors.mutedForeground }}>
            vs {game.opponent}
          </Text>
          <Text style={{ fontSize: 12, fontFamily: 'Inter_400Regular', color: colors.mutedForeground, marginTop: 2 }}>
            {dateStr}
          </Text>
        </View>

        {/* Divider */}
        <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 14 }} />

        {/* Box score table */}
        {game.stats.length > 0 ? (
          <ScrollView showsVerticalScrollIndicator={false}>
            {/* Header row */}
            <View style={{ flexDirection: 'row', paddingHorizontal: 4, marginBottom: 6 }}>
              <Text style={{ flex: 1, fontSize: 11, fontFamily: 'Inter_600SemiBold', color: colors.mutedForeground, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                Player
              </Text>
              {(['PTS', 'REB', 'AST', 'STL', 'BLK', 'TO'] as const).map((col) => (
                <Text key={col} style={{ width: 36, fontSize: 11, fontFamily: 'Inter_600SemiBold', color: colors.mutedForeground, textAlign: 'center', textTransform: 'uppercase', letterSpacing: 0.4 }}>
                  {col}
                </Text>
              ))}
            </View>

            {/* Stat rows — sorted by points desc */}
            {[...game.stats]
              .sort((a, b) => {
                const pts = (s: typeof a) => s.ftMade + 2 * s.twoMade + 3 * s.threeMade;
                return pts(b) - pts(a);
              })
              .map((s, i) => {
                const pts = s.ftMade + 2 * s.twoMade + 3 * s.threeMade;
                return (
                <View
                  key={s.playerId}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingHorizontal: 4,
                    paddingVertical: 8,
                    borderTopWidth: i === 0 ? 0 : 1,
                    borderTopColor: colors.border,
                  }}
                >
                  <Text style={{ flex: 1, fontSize: 13, fontFamily: 'Inter_500Medium', color: colors.foreground }} numberOfLines={1}>
                    #{s.playerId}
                  </Text>
                  {([
                    pts,
                    s.rebounds,
                    s.assists,
                    s.steals,
                    s.blocks,
                    s.turnovers,
                  ] as number[]).map((val, ci) => (
                    <Text key={ci} style={{ width: 36, fontSize: 13, fontFamily: 'Inter_500Medium', color: colors.foreground, textAlign: 'center' }}>
                      {val}
                    </Text>
                  ))}
                </View>
              ); })}
          </ScrollView>
        ) : (
          <Text style={{ textAlign: 'center', color: colors.mutedForeground, fontSize: 14, fontFamily: 'Inter_400Regular', paddingVertical: 16 }}>
            No stats recorded
          </Text>
        )}

        <TouchableOpacity
          onPress={onClose}
          style={{ marginTop: 16, alignItems: 'center', paddingVertical: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.border }}
        >
          <Text style={{ fontSize: 14, fontFamily: 'Inter_600SemiBold', color: colors.mutedForeground }}>Close</Text>
        </TouchableOpacity>
      </View>
    </Modal>
  );
}

// ─── Queued (offline) game row ───────────────────────────────────────────────
function QueuedGameRow({ item, colors, onPress }: { item: QueuedGame; colors: any; onPress: () => void }) {
  const isWin = item.result === 'W';
  const date = new Date(item.date + 'T12:00:00');

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={[
        gameRowStyles.row,
        {
          backgroundColor: colors.card,
          borderColor: 'rgba(255,255,255,0.10)',
          overflow: 'hidden',
          opacity: 0.65,
        },
      ]}
    >
      {/* Date pill */}
      <View style={[gameRowStyles.datePill, { backgroundColor: colors.muted }]}>
        <Text style={[gameRowStyles.dateStr, { color: colors.mutedForeground }]}>
          {date.toLocaleString('en', { month: 'short' })}
        </Text>
        <Text style={[gameRowStyles.dateDay, { color: colors.foreground }]}>
          {date.getDate()}
        </Text>
      </View>

      {/* Middle — opponent + score + syncing badge */}
      <View style={gameRowStyles.rowMid}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 3 }}>
          <Text style={[gameRowStyles.opponent, { color: colors.foreground, marginBottom: 0 }]} numberOfLines={1}>
            vs {item.opponent}
          </Text>
          <View style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 3,
            backgroundColor: 'rgba(255,255,255,0.08)',
            borderRadius: 6,
            paddingHorizontal: 5,
            paddingVertical: 2,
          }}>
            <Ionicons name="cloud-offline-outline" size={10} color={colors.mutedForeground} />
            <Text style={{ fontSize: 9, color: colors.mutedForeground, fontFamily: 'Inter_600SemiBold', letterSpacing: 0.3 }}>
              Syncing…
            </Text>
          </View>
        </View>
        <Text style={[gameRowStyles.score, { color: colors.mutedForeground }]}>
          {item.teamScore} – {item.opponentScore}
        </Text>
      </View>

      {/* W/L badge */}
      <View style={[
        gameRowStyles.resultBadge,
        { backgroundColor: colors.muted, overflow: 'hidden' },
      ]}>
        <Text style={[gameRowStyles.resultText, { color: colors.mutedForeground }]}>
          {isWin ? 'W' : 'L'}
        </Text>
      </View>

      <Feather name="chevron-right" size={15} color={colors.mutedForeground} style={{ marginRight: 12 }} />
    </TouchableOpacity>
  );
}

// ─── Main Screen ────────────────────────────────────────────────────────────
export default function GamesScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedPlayerId, setSelectedPlayerId] = useState<number | null>(null);

  const { data: teams, isLoading: teamsLoading } = useListTeams();
  // -1 = "All Teams" view (uses listAllGames); 0+ = index into the teams array
  const [selectedTeamIdx, setSelectedTeamIdx] = useState(-1);
  const team = selectedTeamIdx >= 0 ? ((teams as any[])?.[selectedTeamIdx] ?? null) : null;

  const { data: players } = useListPlayers();

  const { data: teamGames, isLoading: teamGamesLoading, refetch: refetchTeamGames } = useListTeamGames(
    team?.id ?? 0,
    {
      query: {
        enabled: !!team,
        // Poll every 15 s while any game is still building its playback proxy.
        // React Query v5 passes the Query object, not the data directly.
        refetchInterval: (query: any) =>
          query.state.data?.some((g: any) => g.videoProcessing) ? 15_000 : false,
      } as any,
    },
  );
  const { data: allGames, isLoading: allGamesLoading, refetch: refetchAllGames } = useListAllGames(
    {
      query: {
        enabled: selectedTeamIdx === -1,
        refetchInterval: (query: any) =>
          query.state.data?.some((g: any) => g.videoProcessing) ? 15_000 : false,
      } as any,
    },
  );

  const games = selectedTeamIdx === -1 ? allGames : teamGames;
  const gamesLoading = selectedTeamIdx === -1 ? allGamesLoading : teamGamesLoading;
  function refetch() {
    if (selectedTeamIdx === -1) refetchAllGames(); else refetchTeamGames();
  }

  const deleteGame = useDeleteGame();

  const handleDeleteGame = useCallback((gameId: number, opponent: string) => {
    Alert.alert(
      'Delete Game',
      `Delete game vs ${opponent}? This will permanently remove the recording, stats, and highlights.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            deleteGame.mutate({ gameId }, {
              onSuccess: () => refetch(),
              onError: () => Alert.alert('Error', 'Failed to delete game. Please try again.'),
            });
          },
        },
      ],
    );
  }, [deleteGame, refetch]);

  const filtered = useMemo(() => {
    if (!games) return [];
    const q = search.toLowerCase();
    return (games as any[])
      .filter((g) => !q || g.opponent.toLowerCase().includes(q))
      .filter((g) => {
        if (!selectedPlayerId) return true;
        return (g.stats ?? []).some((s: any) => s.playerId === selectedPlayerId);
      })
      .slice()
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [games, search, selectedPlayerId]);

  // Season stat summary — wins / losses from all games in this team season
  const seasonGames = (games as any[]) ?? [];
  const seasonWins = seasonGames.filter((g) => g.result === 'W').length;
  const seasonLosses = seasonGames.filter((g) => g.result === 'L').length;

  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;

  const styles = makeStyles(colors, insets, isLandscape);
  const isLoading = teamsLoading || gamesLoading;
  const hasPlayers = (players as any[])?.length > 0;
  const hasTeams = (teams?.length ?? 0) > 0;
  // Always allow switching — "All Teams" is always available, even with a single team
  const canSwitchTeam = (teams?.length ?? 0) >= 1;

  const [bannerKey, setBannerKey] = useState(0);

  // ── Offline queue ──────────────────────────────────────────────────────────
  const [queuedGames, setQueuedGames] = useState<QueuedGame[]>([]);
  const [selectedQueuedGame, setSelectedQueuedGame] = useState<QueuedGame | null>(null);

  const reloadQueue = useCallback(() => {
    loadQueuedGames()
      .then(setQueuedGames)
      .catch(() => { /* display errors are non-fatal; queue is still intact */ });
  }, []);

  // Reload on tab focus so games queued mid-session appear immediately.
  useFocusEffect(useCallback(() => { reloadQueue(); }, [reloadQueue]));

  // Reload whenever the server game list refreshes — the background sync calls
  // removeQueuedGame() then invalidates the query, so by the time `games`
  // updates the entry is already gone from AsyncStorage.
  useEffect(() => { reloadQueue(); }, [games, reloadQueue]);

  const visibleQueuedGames = useMemo(() => {
    const q = search.toLowerCase();
    return queuedGames.filter(
      (g) =>
        (selectedTeamIdx === -1 || g.teamId === team?.id) &&
        (!q || g.opponent.toLowerCase().includes(q)) &&
        (!selectedPlayerId || g.stats.some((s) => s.playerId === selectedPlayerId)),
    );
  }, [queuedGames, search, selectedTeamIdx, team, selectedPlayerId]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
    <View style={styles.root}>
      <ScreenGlow primary={colors.primary} />
      <BasketballWatermark color={colors.primary} />

      {/* ── Pending upload recovery ───────────────────────────────────── */}
      <PendingUploadBanner key={bannerKey} onDismiss={() => setBannerKey((k) => k + 1)} />

      {/* ── Page header ──────────────────────────────────────────────── */}
      <View style={styles.header}>
        <View>
          <Text style={[styles.title, { color: colors.foreground }]}>GAMES</Text>
          {/* Season record shown directly under the title — fills the space
              that used to be dead air and surfaces useful data at a glance */}
          {seasonGames.length > 0 && (
            <Text style={[styles.record, { color: colors.mutedForeground }]}>
              {seasonWins}W · {seasonLosses}L · {seasonGames.length} games
            </Text>
          )}
        </View>
        <TouchableOpacity
          onPress={() => router.push('/(tabs)/record')}
          style={[styles.newBtn, { backgroundColor: colors.primary, overflow: 'hidden' }]}
          activeOpacity={0.8}
        >
          <GlareOverlay intensity={0.25} />
          <Feather name="plus" size={22} color="#fff" />
        </TouchableOpacity>
      </View>

      {/* ── Unified filter card ──────────────────────────────────────── */}
      {/* All filter controls live inside one glass card so the screen
          doesn't fragment into floating islands with dead space between them */}
      <View style={[styles.filterCard, { backgroundColor: colors.card, borderColor: 'rgba(255,83,26,0.25)', overflow: 'hidden' }]}>
        <OrangeGlareOverlay strength={0.5} />

        {/* Season selector row */}
        {hasTeams && (
          <TouchableOpacity
            onPress={() => canSwitchTeam && setPickerOpen(true)}
            activeOpacity={canSwitchTeam ? 0.7 : 1}
            style={styles.seasonRow}
          >
            <View style={[styles.seasonDot, { backgroundColor: colors.primary }]} />
            <View style={{ flex: 1 }}>
              <Text style={[styles.seasonName, { color: colors.foreground }]} numberOfLines={1}>
                {team?.name ?? 'All Games'}
              </Text>
              {team?.sport && (
                <Text style={[styles.leagueLabel, { color: colors.primary }]}>
                  {team.sport === 'soccer' ? '⚽ Soccer League' : '🏀 Basketball League'}
                </Text>
              )}
            </View>
            {canSwitchTeam && (
              <>
                <Text style={[styles.seasonCount, { color: colors.mutedForeground }]}>
                  {selectedTeamIdx === -1 ? `${teams?.length ?? 0} teams` : `${selectedTeamIdx + 1} of ${teams?.length}`}
                </Text>
                <Ionicons name="chevron-down" size={15} color={colors.primary} />
              </>
            )}
          </TouchableOpacity>
        )}

        {/* Divider */}
        <View style={[styles.filterDivider, { backgroundColor: colors.border }]} />

        {/* Player chips — horizontal scroll flush inside the card */}
        {hasPlayers && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chipsContent}
          >
            <TouchableOpacity
              onPress={() => setSelectedPlayerId(null)}
              activeOpacity={0.7}
              style={[
                styles.chip,
                {
                  backgroundColor: selectedPlayerId === null ? colors.primary : 'transparent',
                  borderColor: selectedPlayerId === null ? colors.primary : colors.border,
                  overflow: 'hidden',
                },
              ]}
            >
              {selectedPlayerId === null && <GlareOverlay intensity={0.22} />}
              <Text style={[styles.chipText, { color: selectedPlayerId === null ? '#fff' : colors.mutedForeground }]}>All</Text>
            </TouchableOpacity>

            {(players as any[]).map((p) => {
              const active = selectedPlayerId === p.id;
              return (
                <TouchableOpacity
                  key={p.id}
                  onPress={() => setSelectedPlayerId(active ? null : p.id)}
                  activeOpacity={0.7}
                  style={[
                    styles.chip,
                    {
                      backgroundColor: active ? colors.primary : 'transparent',
                      borderColor: active ? colors.primary : colors.border,
                      overflow: 'hidden',
                    },
                  ]}
                >
                  {active && <GlareOverlay intensity={0.22} />}
                  <Text style={[styles.chipText, { color: active ? '#fff' : colors.foreground }]} numberOfLines={1}>
                    {p.name.trim().split(/\s+/)[0]}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        )}

        {/* Divider */}
        <View style={[styles.filterDivider, { backgroundColor: colors.border }]} />

        {/* Search bar — sits flush at the bottom of the filter card */}
        <View style={styles.searchRow}>
          <Ionicons name="search" size={15} color={colors.mutedForeground} />
          <TextInput
            style={[styles.search, { color: colors.foreground }]}
            placeholder="Search opponent…"
            placeholderTextColor={colors.mutedForeground}
            value={search}
            onChangeText={setSearch}
            returnKeyType="search"
          />
          {search.length > 0 && (
            <TouchableOpacity onPress={() => setSearch('')}>
              <Ionicons name="close-circle" size={15} color={colors.mutedForeground} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* ── Game list ────────────────────────────────────────────────── */}
      {!isLoading && filtered.length > 0 && (
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', paddingHorizontal: 20, paddingBottom: 6, gap: 4 }}>
          <Feather name="arrow-left" size={11} color={colors.mutedForeground} />
          <Text style={{ fontSize: 11, fontFamily: 'Inter_400Regular', color: colors.mutedForeground }}>Swipe left to delete</Text>
        </View>
      )}
      {isLoading ? (
        <View style={styles.centered}><ActivityIndicator color={colors.primary} /></View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item: any) => String(item.id)}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={false} onRefresh={refetch} tintColor={colors.primary} />}
          ListHeaderComponent={
            visibleQueuedGames.length > 0 ? (
              <>
                {visibleQueuedGames.map((qg) => (
                  <QueuedGameRow
                    key={qg.clientId}
                    item={qg}
                    colors={colors}
                    onPress={() => setSelectedQueuedGame(qg)}
                  />
                ))}
                {filtered.length > 0 && (
                  <View style={{ height: 1, backgroundColor: colors.border, marginBottom: 8, marginHorizontal: 2 }} />
                )}
              </>
            ) : null
          }
          renderItem={({ item }) => (
            <GameRow item={item} onDelete={handleDeleteGame} colors={colors} router={router} />
          )}
          ListEmptyComponent={
            visibleQueuedGames.length === 0 ? (
              <View style={styles.empty}>
                <Ionicons name="basketball-outline" size={44} color={colors.mutedForeground} />
                <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
                  {search ? 'No matches' : 'No games yet'}
                </Text>
                <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
                  {search ? 'Try a different opponent name' : 'Tap + to record your first game'}
                </Text>
              </View>
            ) : null
          }
        />
      )}

      <QueuedGameBoxScoreModal
        game={selectedQueuedGame}
        onClose={() => setSelectedQueuedGame(null)}
        colors={colors}
        insets={insets}
      />

      <SeasonPickerModal
        visible={pickerOpen}
        teams={teams ?? []}
        selectedIdx={selectedTeamIdx}
        onSelect={setSelectedTeamIdx}
        onClose={() => setPickerOpen(false)}
        colors={colors}
        insets={insets}
      />
    </View>
    </GestureHandlerRootView>
  );
}

function makeStyles(colors: any, insets: any, isLandscape = false) {
  // In landscape, compact the filter card so the game list has more room.
  const hPad = 16 + (insets.left ?? 0);   // left-side horizontal padding (safe area + margin)
  const hPadR = 16 + (insets.right ?? 0); // right-side horizontal padding

  return StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },

    // ── Header ──────────────────────────────────────────────────────
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
      paddingTop: insets.top + (Platform.OS === 'web' ? 67 : Platform.OS === 'ios' ? (isLandscape ? 6 : 14) : 24),
      paddingLeft: hPad,
      paddingRight: hPadR,
      paddingBottom: isLandscape ? 6 : 14,
    },
    title: { ...tekoStyle(isLandscape ? 38 : 52), letterSpacing: 0.5 },
    record: { fontSize: 13, fontFamily: 'Inter_500Medium', marginTop: -2 },
    newBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', marginTop: 4 },

    // ── Unified filter card ──────────────────────────────────────────
    // One glass card for season + chips + search, so the screen has a
    // single cohesive block of controls instead of floating fragments.
    // In landscape, margins and inner padding are tightened so the card
    // takes less vertical space and leaves more room for the game list.
    filterCard: {
      marginLeft: hPad,
      marginRight: hPadR,
      marginBottom: isLandscape ? 6 : 12,
      borderRadius: 16,
      borderWidth: 1.5,
    },
    seasonRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 14,
      paddingVertical: isLandscape ? 7 : 13,
    },
    seasonDot: { width: 8, height: 8, borderRadius: 4 },
    seasonName: { fontSize: 15, fontFamily: 'Inter_600SemiBold' },
    leagueLabel: { fontSize: 11, fontFamily: 'Inter_500Medium', marginTop: 1 },
    seasonCount: { fontSize: 12, fontFamily: 'Inter_400Regular' },

    filterDivider: { height: 1, marginHorizontal: 0 },

    chipsContent: {
      paddingHorizontal: 12,
      paddingVertical: isLandscape ? 6 : 10,
      gap: 8,
      alignItems: 'center',
      flexDirection: 'row',
    },
    chip: {
      paddingHorizontal: isLandscape ? 12 : 16,
      paddingVertical: isLandscape ? 4 : 7,
      borderRadius: 22,
      borderWidth: 1,
    },
    chipText: { fontSize: 13, fontFamily: 'Inter_700Bold' },

    searchRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 14,
      paddingVertical: isLandscape ? 6 : 10,
    },
    search: { flex: 1, fontSize: 14, fontFamily: 'Inter_400Regular', height: 24 },

    // ── Game rows ────────────────────────────────────────────────────
    list: { paddingLeft: hPad, paddingRight: hPadR, paddingBottom: insets.bottom + 100, paddingTop: 2 },
    row: { flexDirection: 'row', alignItems: 'center', borderRadius: 14, borderWidth: 1, marginBottom: 8 },
    datePill: { width: 56, alignItems: 'center', justifyContent: 'center', paddingVertical: 14, borderTopLeftRadius: 14, borderBottomLeftRadius: 14 },
    dateStr: { fontSize: 10, textTransform: 'uppercase', fontFamily: 'Inter_500Medium', letterSpacing: 0.5 },
    dateDay: { ...tekoStyle(30) },
    rowMid: { flex: 1, paddingHorizontal: 12, paddingVertical: 12 },
    opponent: { fontSize: 15, fontFamily: 'Inter_700Bold', marginBottom: 3 },
    score: { ...tekoStyle(15), letterSpacing: 0.3 },
    resultBadge: { width: 38, height: 38, borderRadius: 10, marginRight: 6, alignItems: 'center', justifyContent: 'center' },
    resultText: { ...tekoStyle(20), letterSpacing: 0.5 },

    // ── Empty state ──────────────────────────────────────────────────
    empty: { alignItems: 'center', paddingTop: 48, gap: 8 },
    emptyTitle: { ...tekoStyle(28), letterSpacing: 0.5 },
    emptyText: { fontSize: 14, fontFamily: 'Inter_400Regular', textAlign: 'center', color: '#888' },
  });
}
