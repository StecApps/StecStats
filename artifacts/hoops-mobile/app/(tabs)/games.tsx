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
} from 'react-native';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useListTeams, useListTeamGames } from '@workspace/api-client-react';
import { Ionicons, Feather } from '@expo/vector-icons';

export default function GamesScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [search, setSearch] = useState('');

  const { data: teams, isLoading: teamsLoading } = useListTeams();
  const [selectedTeamIdx, setSelectedTeamIdx] = useState(0);
  const team = teams?.[selectedTeamIdx] ?? null;

  const { data: games, isLoading: gamesLoading, refetch } = useListTeamGames(
    team?.id ?? 0,
    { query: { enabled: !!team } },
  );

  const filtered = useMemo(() => {
    if (!games) return [];
    const q = search.toLowerCase();
    return (games as any[])
      .filter((g) => !q || g.opponent.toLowerCase().includes(q))
      .slice()
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [games, search]);

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

      {/* Team selector */}
      {(teams?.length ?? 0) > 1 && (
        <FlatList
          horizontal
          data={teams}
          keyExtractor={(t: any) => String(t.id)}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.teamTabs}
          renderItem={({ item: t, index }) => (
            <TouchableOpacity
              onPress={() => setSelectedTeamIdx(index)}
              style={[
                styles.teamTab,
                {
                  backgroundColor: selectedTeamIdx === index ? colors.primary : colors.card,
                  borderColor: selectedTeamIdx === index ? colors.primary : colors.border,
                },
              ]}
              activeOpacity={0.7}
            >
              <Text
                style={[
                  styles.teamTabText,
                  { color: selectedTeamIdx === index ? '#fff' : colors.foreground },
                ]}
              >
                {(t as any).name}
              </Text>
            </TouchableOpacity>
          )}
        />
      )}

      {/* Search */}
      <View style={styles.searchWrap}>
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
        <View style={styles.centered}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item: any) => String(item.id)}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={false} onRefresh={refetch} tintColor={colors.primary} />
          }
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
                <View
                  style={[
                    styles.resultBadge,
                    { backgroundColor: isWin ? colors.primary + '25' : colors.muted },
                  ]}
                >
                  <Text
                    style={[
                      styles.resultText,
                      { color: isWin ? colors.primary : colors.mutedForeground },
                    ]}
                  >
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
      paddingTop: insets.top + (Platform.OS === 'web' ? 67 : (Platform.OS === 'ios' ? 12 : 24)),
      paddingHorizontal: 16,
      paddingBottom: 12,
    },
    title: { fontSize: 28, fontFamily: 'Inter_700Bold', color: colors.foreground },
    newBtn: {
      width: 38,
      height: 38,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
    },
    teamTabs: { paddingHorizontal: 16, gap: 8, paddingBottom: 12 },
    teamTab: {
      paddingHorizontal: 14,
      paddingVertical: 7,
      borderRadius: 20,
      borderWidth: 1,
    },
    teamTabText: { fontSize: 13, fontFamily: 'Inter_500Medium' },
    searchWrap: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.input,
      borderRadius: 10,
      marginHorizontal: 16,
      marginBottom: 12,
      borderWidth: 1,
      borderColor: colors.border,
    },
    search: {
      flex: 1,
      height: 40,
      paddingHorizontal: 10,
      fontSize: 15,
      fontFamily: 'Inter_400Regular',
    },
    list: { paddingHorizontal: 16, paddingBottom: insets.bottom + 100 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      borderRadius: 10,
      borderWidth: 1,
      marginBottom: 8,
    },
    datePill: {
      width: 52,
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 10,
    },
    dateStr: { fontSize: 10, textTransform: 'uppercase', fontFamily: 'Inter_500Medium' },
    dateDay: { fontSize: 22, lineHeight: 24 },
    rowMid: { flex: 1, paddingHorizontal: 12, paddingVertical: 10 },
    opponent: { fontSize: 15, fontFamily: 'Inter_600SemiBold', marginBottom: 2 },
    score: { fontSize: 13, fontFamily: 'Inter_400Regular' },
    resultBadge: {
      width: 36,
      height: 36,
      borderRadius: 8,
      marginRight: 6,
      alignItems: 'center',
      justifyContent: 'center',
    },
    resultText: { fontSize: 14, fontFamily: 'Inter_700Bold' },
    empty: { alignItems: 'center', paddingTop: 60, gap: 12 },
    emptyText: { fontSize: 15, fontFamily: 'Inter_400Regular' },
  });
}
