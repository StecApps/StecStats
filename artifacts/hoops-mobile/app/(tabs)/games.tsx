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
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LinearGradient } from 'expo-linear-gradient';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import { useListTeams, useListTeamGames, useListPlayers, useCreateGame, useRequestUploadUrl } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@clerk/clerk-expo';
import { Ionicons, Feather } from '@expo/vector-icons';
import { tekoStyle } from '@/lib/tekoStyle';
import { uploadVideoFile } from '@/lib/uploadVideoFile';
import { saveGame } from '@/lib/saveGame';
import { PENDING_UPLOAD_KEY, type PendingUpload } from '@/app/scorekeeper';

// ─── Pending upload recovery banner ────────────────────────────────────────
function PendingUploadBanner({ onDismiss }: { onDismiss: () => void }) {
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

// ─── Main Screen ────────────────────────────────────────────────────────────
export default function GamesScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedPlayerId, setSelectedPlayerId] = useState<number | null>(null);

  const { data: teams, isLoading: teamsLoading } = useListTeams();
  const [selectedTeamIdx, setSelectedTeamIdx] = useState(0);
  const team = (teams as any[])?.[selectedTeamIdx] ?? null;

  const { data: players } = useListPlayers();

  const { data: games, isLoading: gamesLoading, refetch } = useListTeamGames(
    team?.id ?? 0,
    { query: { enabled: !!team } as any },
  );

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
  const canSwitchTeam = (teams?.length ?? 0) > 1;

  const [bannerKey, setBannerKey] = useState(0);

  return (
    <View style={styles.root}>

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
            <Text style={[styles.seasonName, { color: colors.foreground }]} numberOfLines={1}>
              {team?.name ?? 'All Games'}
            </Text>
            {canSwitchTeam && (
              <>
                <Text style={[styles.seasonCount, { color: colors.mutedForeground }]}>
                  {selectedTeamIdx + 1} of {teams?.length}
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
      {isLoading ? (
        <View style={styles.centered}><ActivityIndicator color={colors.primary} /></View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item: any) => String(item.id)}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={false} onRefresh={refetch} tintColor={colors.primary} />}
          renderItem={({ item }) => {
            const isWin = item.result === 'W';
            const date = new Date(item.date);
            return (
              <TouchableOpacity
                onPress={() => router.push(`/game/${item.id}`)}
                activeOpacity={0.7}
                style={[styles.row, { backgroundColor: colors.card, borderColor: 'rgba(255,83,26,0.20)', overflow: 'hidden' }]}
              >
                <OrangeGlareOverlay strength={0.4} />
                {/* Date column */}
                <View style={[styles.datePill, { backgroundColor: colors.muted }]}>
                  <Text style={[styles.dateStr, { color: colors.mutedForeground }]}>
                    {date.toLocaleString('en', { month: 'short' })}
                  </Text>
                  <Text style={[styles.dateDay, { color: colors.foreground }]}>
                    {date.getDate()}
                  </Text>
                </View>
                {/* Middle */}
                <View style={styles.rowMid}>
                  <Text style={[styles.opponent, { color: colors.foreground }]} numberOfLines={1}>
                    vs {item.opponent}
                  </Text>
                  <Text style={[styles.score, { color: colors.mutedForeground }]}>
                    {item.teamScore} – {item.opponentScore}
                  </Text>
                </View>
                {/* Win/Loss badge */}
                <View style={[
                  styles.resultBadge,
                  { backgroundColor: isWin ? 'rgba(255,83,26,0.22)' : colors.muted, overflow: 'hidden' },
                ]}>
                  {isWin && <GlareOverlay intensity={0.18} />}
                  <Text style={[styles.resultText, { color: isWin ? colors.primary : colors.mutedForeground }]}>
                    {isWin ? 'W' : 'L'}
                  </Text>
                </View>
                <Feather name="chevron-right" size={15} color={colors.mutedForeground} style={{ marginRight: 12 }} />
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="basketball-outline" size={44} color={colors.mutedForeground} />
              <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
                {search ? 'No matches' : 'No games yet'}
              </Text>
              <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
                {search ? 'Try a different opponent name' : 'Tap + to record your first game'}
              </Text>
            </View>
          }
        />
      )}

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
    seasonName: { flex: 1, fontSize: 15, fontFamily: 'Inter_600SemiBold' },
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
