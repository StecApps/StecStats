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
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useListTeams, useListTeamGames, useListPlayers } from '@workspace/api-client-react';
import { Ionicons, Feather } from '@expo/vector-icons';

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
                  { borderColor: isSelected ? colors.primary : colors.border, backgroundColor: isSelected ? colors.primary + '15' : 'transparent' },
                ]}
              >
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
        <Text style={styles.title}>Games</Text>
        <TouchableOpacity
          onPress={() => router.push('/(tabs)/record')}
          style={[styles.newBtn, { backgroundColor: colors.primary }]}
          activeOpacity={0.8}
        >
          <Feather name="plus" size={18} color="#fff" />
        </TouchableOpacity>
      </View>

      {/* Season selector button */}
      {(teams?.length ?? 0) > 0 && (
        <TouchableOpacity
          onPress={() => (teams?.length ?? 0) > 1 && setPickerOpen(true)}
          activeOpacity={(teams?.length ?? 0) > 1 ? 0.7 : 1}
          style={[styles.seasonBtn, { backgroundColor: colors.card, borderColor: (teams?.length ?? 0) > 1 ? colors.primary : colors.border }]}
        >
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
                backgroundColor: selectedPlayerId === null ? colors.primary : colors.muted,
                borderColor: selectedPlayerId === null ? colors.primary : colors.border,
              },
            ]}
          >
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
                  backgroundColor: selectedPlayerId === p.id ? colors.primary : colors.secondary,
                  borderColor: selectedPlayerId === p.id ? colors.primary : colors.mutedForeground,
                },
              ]}
            >
              <Text style={[styles.playerChipText, { color: '#FFFFFF' }]} numberOfLines={1}>
                {p.name.trim().split(/\s+/)[0]}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      {/* Search */}
      <View style={[styles.searchWrap, { backgroundColor: colors.input, borderColor: colors.border }]}>
        <Ionicons name="search" size={16} color={colors.mutedForeground} style={{ paddingLeft: 12 }} />
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
                style={[styles.row, { backgroundColor: colors.card, borderColor: colors.border }]}
              >
                <View style={[styles.datePill, { backgroundColor: colors.muted }]}>
                  <Text style={[styles.dateStr, { color: colors.mutedForeground }]}>
                    {date.toLocaleString('en', { month: 'short' })}
                  </Text>
                  <Text style={[styles.dateDay, { color: colors.foreground, fontFamily: 'Teko_700Bold' }]}>
                    {date.getDate()}
                  </Text>
                </View>
                <View style={styles.rowMid}>
                  <Text style={[styles.opponent, { color: colors.foreground }]} numberOfLines={1}>
                    vs {item.opponent}
                  </Text>
                  <Text style={[styles.score, { color: colors.mutedForeground }]}>
                    {item.teamScore} – {item.opponentScore}
                  </Text>
                </View>
                <View style={[styles.resultBadge, { backgroundColor: isWin ? colors.primary + '25' : colors.muted }]}>
                  <Text style={[styles.resultText, { color: isWin ? colors.primary : colors.mutedForeground }]}>
                    {isWin ? 'W' : 'L'}
                  </Text>
                </View>
                <Feather name="chevron-right" size={16} color={colors.mutedForeground} style={{ marginRight: 10 }} />
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="basketball-outline" size={40} color={colors.mutedForeground} />
              <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
                {search ? 'No games match your search' : 'No games recorded yet'}
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
      paddingBottom: 12,
    },
    title: { fontSize: 28, fontFamily: 'Inter_700Bold', color: colors.foreground },
    newBtn: { width: 38, height: 38, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
    seasonBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginHorizontal: 16,
      marginBottom: 10,
      borderRadius: 12,
      borderWidth: 1.5,
      paddingHorizontal: 14,
      paddingVertical: 11,
    },
    seasonDot: { width: 8, height: 8, borderRadius: 4 },
    seasonName: { flex: 1, fontSize: 15, fontFamily: 'Inter_600SemiBold' },
    seasonCount: { fontSize: 12, fontFamily: 'Inter_400Regular' },
    searchWrap: {
      flexDirection: 'row',
      alignItems: 'center',
      borderRadius: 10,
      marginHorizontal: 16,
      marginBottom: 12,
      borderWidth: 1,
    },
    search: { flex: 1, height: 40, paddingHorizontal: 10, fontSize: 15, fontFamily: 'Inter_400Regular' },
    list: { paddingHorizontal: 16, paddingBottom: insets.bottom + 100 },
    row: { flexDirection: 'row', alignItems: 'center', borderRadius: 10, borderWidth: 1, marginBottom: 8 },
    datePill: { width: 52, alignItems: 'center', justifyContent: 'center', paddingVertical: 10 },
    dateStr: { fontSize: 10, textTransform: 'uppercase', fontFamily: 'Inter_500Medium' },
    dateDay: { fontSize: 22, lineHeight: 24 },
    rowMid: { flex: 1, paddingHorizontal: 12, paddingVertical: 10 },
    opponent: { fontSize: 15, fontFamily: 'Inter_600SemiBold', marginBottom: 2 },
    score: { fontSize: 13, fontFamily: 'Inter_400Regular' },
    resultBadge: { width: 36, height: 36, borderRadius: 8, marginRight: 6, alignItems: 'center', justifyContent: 'center' },
    resultText: { fontSize: 14, fontFamily: 'Inter_700Bold' },
    empty: { alignItems: 'center', paddingTop: 60, gap: 12 },
    emptyText: { fontSize: 15, fontFamily: 'Inter_400Regular' },
    playerChip: {
      paddingHorizontal: 14,
      paddingVertical: 6,
      borderRadius: 20,
      borderWidth: 1,
    },
    playerChipText: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  });
}
