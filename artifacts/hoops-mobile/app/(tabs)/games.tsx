import React, { useMemo, useState } from 'react';
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
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useListTeams, useListTeamGames, useListPlayers } from '@workspace/api-client-react';
import { Ionicons, Feather } from '@expo/vector-icons';
import { tekoStyle } from '@/lib/tekoStyle';

// ─── Glass glare overlay ────────────────────────────────────────────────────
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

// ─── Season Picker Modal ───────────────────────────────────────────────────
function SeasonPickerModal({
  visible,
  teams,
  selectedIdx,
  onSelect,
  onClose,
  colors,
  insets,
}: {
  visible: boolean;
  teams: any[];
  selectedIdx: number;
  onSelect: (i: number) => void;
  onClose: () => void;
  colors: any;
  insets: any;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={modalS.backdrop} onPress={onClose} />
      <View style={[modalS.sheet, { backgroundColor: colors.card, paddingBottom: insets.bottom + 16 }]}>
        {/* Handle */}
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
                  { borderColor: isSelected ? colors.primary : colors.border, backgroundColor: isSelected ? colors.primary + '15' : 'transparent', overflow: 'hidden' },
                ]}
              >
                {isSelected && <GlareOverlay intensity={0.08} />}
                <View style={modalS.rowLeft}>
                  <Text style={[modalS.teamName, { color: colors.foreground }]} numberOfLines={1}>
                    {t.name}
                  </Text>
                  {t.sport && (
                    <Text style={[modalS.sport, { color: colors.mutedForeground }]}>
                      {t.sport.charAt(0).toUpperCase() + t.sport.slice(1)}
                    </Text>
                  )}
                </View>
                {isSelected && (
                  <Ionicons name="checkmark-circle" size={22} color={colors.primary} />
                )}
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
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 16,
    paddingTop: 12,
    maxHeight: '75%',
  },
  handle: { width: 36, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: 16 },
  title: { fontSize: 17, fontFamily: 'Inter_700Bold', marginBottom: 12, textAlign: 'center' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginBottom: 8,
  },
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

  const styles = makeStyles(colors, insets);
  const isLoading = teamsLoading || gamesLoading;

  return (
    <View style={styles.root}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={[styles.title, { color: colors.foreground }]}>GAMES</Text>
        <TouchableOpacity
          onPress={() => router.push('/(tabs)/record')}
          style={[styles.newBtn, { backgroundColor: colors.primary, overflow: 'hidden' }]}
          activeOpacity={0.8}
        >
          <GlareOverlay intensity={0.22} />
          <Feather name="plus" size={20} color="#fff" />
        </TouchableOpacity>
      </View>

      {/* Season selector button */}
      {(teams?.length ?? 0) > 0 && (
        <TouchableOpacity
          onPress={() => (teams?.length ?? 0) > 1 && setPickerOpen(true)}
          activeOpacity={(teams?.length ?? 0) > 1 ? 0.7 : 1}
          style={[
            styles.seasonBtn,
            {
              backgroundColor: colors.card,
              borderColor: (teams?.length ?? 0) > 1 ? colors.primary : colors.border,
              overflow: 'hidden',
            },
          ]}
        >
          <GlareOverlay intensity={0.07} />
          <View style={[styles.seasonDot, { backgroundColor: colors.primary }]} />
          <Text style={[styles.seasonName, { color: colors.foreground }]} numberOfLines={1}>
            {team?.name ?? 'All Games'}
          </Text>
          {(teams?.length ?? 0) > 1 && (
            <>
              <Text style={[styles.seasonCount, { color: colors.mutedForeground }]}>
                {selectedTeamIdx + 1} of {teams?.length}
              </Text>
              <Ionicons name="chevron-down" size={16} color={colors.primary} />
            </>
          )}
        </TouchableOpacity>
      )}

      {/* Player filter chips */}
      {(players as any[])?.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ flexShrink: 0 }}
          contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 8, gap: 8, alignItems: 'center' }}
        >
          <TouchableOpacity
            onPress={() => setSelectedPlayerId(null)}
            activeOpacity={0.7}
            style={[
              styles.playerChip,
              {
                backgroundColor: selectedPlayerId === null ? colors.primary : colors.card,
                borderColor: selectedPlayerId === null ? colors.primary : colors.border,
                overflow: 'hidden',
              },
            ]}
          >
            {selectedPlayerId === null && <GlareOverlay intensity={0.2} />}
            <Text style={[styles.playerChipText, { color: selectedPlayerId === null ? '#fff' : colors.mutedForeground }]}>
              All
            </Text>
          </TouchableOpacity>
          {(players as any[]).map((p) => (
            <TouchableOpacity
              key={p.id}
              onPress={() => setSelectedPlayerId(p.id === selectedPlayerId ? null : p.id)}
              activeOpacity={0.7}
              style={[
                styles.playerChip,
                {
                  backgroundColor: selectedPlayerId === p.id ? colors.primary : colors.card,
                  borderColor: selectedPlayerId === p.id ? colors.primary : colors.border,
                  overflow: 'hidden',
                },
              ]}
            >
              {selectedPlayerId === p.id && <GlareOverlay intensity={0.2} />}
              <Text style={[styles.playerChipText, { color: selectedPlayerId === p.id ? '#fff' : colors.foreground }]} numberOfLines={1}>
                {p.name.trim().split(/\s+/)[0]}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      {/* Search */}
      <View style={[styles.searchWrap, { backgroundColor: colors.card, borderColor: colors.border, overflow: 'hidden' }]}>
        <GlareOverlay intensity={0.05} />
        <Ionicons name="search" size={16} color={colors.mutedForeground} style={{ paddingLeft: 14 }} />
        <TextInput
          style={[styles.search, { color: colors.foreground }]}
          placeholder="Search opponent…"
          placeholderTextColor={colors.mutedForeground}
          value={search}
          onChangeText={setSearch}
          returnKeyType="search"
        />
        {search.length > 0 && (
          <TouchableOpacity onPress={() => setSearch('')} style={{ paddingRight: 12 }}>
            <Ionicons name="close-circle" size={16} color={colors.mutedForeground} />
          </TouchableOpacity>
        )}
      </View>

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
                style={[styles.row, { backgroundColor: colors.card, borderColor: colors.border, overflow: 'hidden' }]}
              >
                <GlareOverlay intensity={0.06} />
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
                {/* Result badge */}
                <View style={[
                  styles.resultBadge,
                  { backgroundColor: isWin ? colors.primary + '22' : colors.muted, overflow: 'hidden' },
                ]}>
                  {isWin && <GlareOverlay intensity={0.15} />}
                  <Text style={[styles.resultText, { color: isWin ? colors.primary : colors.mutedForeground }]}>
                    {isWin ? 'W' : 'L'}
                  </Text>
                </View>
                <Feather name="chevron-right" size={16} color={colors.mutedForeground} style={{ marginRight: 12 }} />
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

      {/* Season Picker Modal */}
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

function makeStyles(colors: any, insets: any) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingTop: insets.top + (Platform.OS === 'web' ? 67 : Platform.OS === 'ios' ? 12 : 24),
      paddingHorizontal: 16,
      paddingBottom: 10,
    },
    // Teko makes "GAMES" feel like a scoreboard header — dramatic, condensed, sporty
    title: { ...tekoStyle(48), letterSpacing: 0.5 },
    newBtn: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
    seasonBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginHorizontal: 16,
      marginBottom: 10,
      borderRadius: 14,
      borderWidth: 1.5,
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
    seasonDot: { width: 8, height: 8, borderRadius: 4 },
    seasonName: { flex: 1, fontSize: 15, fontFamily: 'Inter_600SemiBold' },
    seasonCount: { fontSize: 12, fontFamily: 'Inter_400Regular' },
    searchWrap: {
      flexDirection: 'row',
      alignItems: 'center',
      borderRadius: 14,
      marginHorizontal: 16,
      marginBottom: 12,
      borderWidth: 1,
    },
    search: { flex: 1, height: 44, paddingHorizontal: 10, fontSize: 15, fontFamily: 'Inter_400Regular' },
    list: { paddingHorizontal: 16, paddingBottom: insets.bottom + 100 },
    row: { flexDirection: 'row', alignItems: 'center', borderRadius: 14, borderWidth: 1, marginBottom: 8 },
    datePill: { width: 56, alignItems: 'center', justifyContent: 'center', paddingVertical: 12 },
    dateStr: { fontSize: 10, textTransform: 'uppercase', fontFamily: 'Inter_500Medium', letterSpacing: 0.5 },
    // Teko makes the day number punchy and bold — anchors the date pill visually
    dateDay: { ...tekoStyle(28) },
    rowMid: { flex: 1, paddingHorizontal: 12, paddingVertical: 12 },
    opponent: { fontSize: 15, fontFamily: 'Inter_700Bold', marginBottom: 3 },
    // Teko score — small but condensed and athletic
    score: { ...tekoStyle(15), letterSpacing: 0.5 },
    resultBadge: { width: 38, height: 38, borderRadius: 10, marginRight: 6, alignItems: 'center', justifyContent: 'center' },
    resultText: { ...tekoStyle(18), letterSpacing: 0.5 },
    playerChip: {
      paddingHorizontal: 16,
      paddingVertical: 7,
      borderRadius: 22,
      borderWidth: 1,
    },
    playerChipText: { fontSize: 13, fontFamily: 'Inter_700Bold' },
    empty: { alignItems: 'center', paddingTop: 60, gap: 8 },
    emptyTitle: { ...tekoStyle(26), letterSpacing: 0.5 },
    emptyText: { fontSize: 14, fontFamily: 'Inter_400Regular', textAlign: 'center' },
  });
}
