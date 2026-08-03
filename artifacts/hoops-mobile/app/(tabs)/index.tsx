import React, { useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Platform,
} from 'react-native';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useListTeams, useListTeamGames, useListPlayers } from '@workspace/api-client-react';
import { Ionicons, Feather } from '@expo/vector-icons';

function StatCard({ label, value, colors }: { label: string; value: string; colors: any }) {
  return (
    <View style={[cardStyles.wrap, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Text style={[cardStyles.value, { color: colors.foreground, fontFamily: 'Teko_700Bold' }]}>
        {value}
      </Text>
      <Text style={[cardStyles.label, { color: colors.mutedForeground }]}>{label}</Text>
    </View>
  );
}

const cardStyles = StyleSheet.create({
  wrap: {
    flex: 1,
    borderRadius: 10,
    borderWidth: 1,
    padding: 14,
    alignItems: 'center',
    gap: 2,
  },
  value: { fontSize: 28, lineHeight: 30 },
  label: { fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase', fontFamily: 'Inter_500Medium' },
});

function GameRow({ game, colors, onPress }: { game: any; colors: any; onPress: () => void }) {
  const isWin = game.result === 'W';
  const date = new Date(game.date);
  const month = date.toLocaleString('en', { month: 'short' });
  const day = date.getDate();

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={[rowStyles.row, { backgroundColor: colors.card, borderColor: colors.border }]}
    >
      <View style={[rowStyles.dateBadge, { backgroundColor: colors.muted }]}>
        <Text style={[rowStyles.dateMonth, { color: colors.mutedForeground }]}>{month}</Text>
        <Text style={[rowStyles.dateDay, { color: colors.foreground, fontFamily: 'Teko_700Bold' }]}>{day}</Text>
      </View>
      <View style={rowStyles.middle}>
        <Text style={[rowStyles.opponent, { color: colors.foreground }]} numberOfLines={1}>
          vs {game.opponent}
        </Text>
        <Text style={[rowStyles.scores, { color: colors.mutedForeground }]}>
          {game.teamScore} – {game.opponentScore}
        </Text>
      </View>
      <View style={[rowStyles.badge, { backgroundColor: isWin ? colors.primary + '22' : colors.muted }]}>
        <Text style={[rowStyles.badgeText, { color: isWin ? colors.primary : colors.mutedForeground }]}>
          {isWin ? 'W' : 'L'}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

const rowStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 10,
    borderWidth: 1,
    marginBottom: 8,
    overflow: 'hidden',
  },
  dateBadge: {
    width: 52,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dateMonth: { fontSize: 10, textTransform: 'uppercase', fontFamily: 'Inter_500Medium' },
  dateDay: { fontSize: 22, lineHeight: 24 },
  middle: { flex: 1, paddingHorizontal: 12, paddingVertical: 12 },
  opponent: { fontSize: 15, fontFamily: 'Inter_600SemiBold', marginBottom: 2 },
  scores: { fontSize: 13, fontFamily: 'Inter_400Regular' },
  badge: { width: 40, height: 40, borderRadius: 8, marginRight: 12, alignItems: 'center', justifyContent: 'center' },
  badgeText: { fontSize: 14, fontFamily: 'Inter_700Bold' },
});

export default function DashboardScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const { data: teams, isLoading: teamsLoading, refetch: refetchTeams } = useListTeams();
  const team = teams?.[0] ?? null;

  const { data: games, isLoading: gamesLoading, refetch: refetchGames } = useListTeamGames(
    team?.id ?? 0,
    { query: { enabled: !!team } },
  );

  const { data: players } = useListPlayers();

  const isLoading = teamsLoading || gamesLoading;

  const stats = useMemo(() => {
    if (!games) return { wins: 0, losses: 0, ppg: '—', record: '0-0' };
    const wins = games.filter((g: any) => g.result === 'W').length;
    const losses = games.length - wins;
    const ppg = games.length > 0
      ? (games.reduce((s: number, g: any) => s + g.teamScore, 0) / games.length).toFixed(1)
      : '—';
    return { wins, losses, ppg, record: `${wins}-${losses}` };
  }, [games]);

  // Top performers: aggregate points per player across all games
  const topPerformers = useMemo(() => {
    if (!games || !players) return [];
    const totals: Record<number, { name: string; points: number; games: number }> = {};
    for (const game of games as any[]) {
      for (const stat of game.stats ?? []) {
        if (!totals[stat.playerId]) {
          totals[stat.playerId] = { name: stat.playerName, points: 0, games: 0 };
        }
        totals[stat.playerId].points += stat.points ?? 0;
        totals[stat.playerId].games += 1;
      }
    }
    return Object.values(totals)
      .sort((a, b) => b.points / b.games - a.points / a.games)
      .slice(0, 3);
  }, [games, players]);

  const recentGames = (games as any[])?.slice().reverse().slice(0, 5) ?? [];

  const styles = makeStyles(colors, insets);

  if (isLoading) {
    return (
      <View style={[styles.root, styles.centered]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (!team) {
    return (
      <View style={[styles.root, styles.centered]}>
        <Ionicons name="basketball-outline" size={48} color={colors.mutedForeground} />
        <Text style={styles.emptyTitle}>No team yet</Text>
        <Text style={styles.emptyBody}>Head to the Record tab to start tracking your first game.</Text>
      </View>
    );
  }

  return (
    <FlatList
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={styles.list}
      refreshControl={
        <RefreshControl
          refreshing={false}
          onRefresh={() => { refetchTeams(); refetchGames(); }}
          tintColor={colors.primary}
        />
      }
      data={recentGames}
      keyExtractor={(item: any) => String(item.id)}
      ListHeaderComponent={
        <>
          {/* Header */}
          <View style={styles.header}>
            <View>
              <Text style={styles.teamName}>{team.name}</Text>
              <Text style={styles.season}>{new Date().getFullYear()} Season</Text>
            </View>
            <TouchableOpacity
              style={[styles.recordBtn, { backgroundColor: colors.primary }]}
              onPress={() => router.push('/(tabs)/record')}
              activeOpacity={0.8}
            >
              <Feather name="plus" size={18} color="#fff" />
            </TouchableOpacity>
          </View>

          {/* Season stats strip */}
          <View style={styles.statsRow}>
            <StatCard label="Record" value={stats.record} colors={colors} />
            <View style={{ width: 8 }} />
            <StatCard label="PPG" value={stats.ppg} colors={colors} />
            <View style={{ width: 8 }} />
            <StatCard label="Wins" value={String(stats.wins)} colors={colors} />
          </View>

          {/* Top performers */}
          {topPerformers.length > 0 && (
            <>
              <Text style={styles.sectionTitle}>Top Performers</Text>
              {topPerformers.map((p: any, i: number) => (
                <View key={p.name} style={[styles.performerRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  <Text style={[styles.performerRank, { color: colors.primary, fontFamily: 'Teko_700Bold' }]}>
                    #{i + 1}
                  </Text>
                  <Text style={[styles.performerName, { color: colors.foreground }]}>{p.name}</Text>
                  <Text style={[styles.performerStat, { color: colors.mutedForeground }]}>
                    {(p.points / p.games).toFixed(1)} ppg
                  </Text>
                </View>
              ))}
            </>
          )}

          {recentGames.length > 0 && (
            <Text style={styles.sectionTitle}>Recent Games</Text>
          )}
        </>
      }
      renderItem={({ item }) => (
        <GameRow
          game={item}
          colors={colors}
          onPress={() => router.push(`/game/${item.id}`)}
        />
      )}
      ListEmptyComponent={
        <View style={styles.emptyGames}>
          <Ionicons name="basketball-outline" size={36} color={colors.mutedForeground} />
          <Text style={[styles.emptyBody, { marginTop: 8 }]}>No games recorded yet</Text>
        </View>
      }
    />
  );
}

function makeStyles(colors: any, insets: any) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    centered: { alignItems: 'center', justifyContent: 'center' },
    list: {
      paddingTop: insets.top + (Platform.OS === 'web' ? 67 : 0),
      paddingHorizontal: 16,
      paddingBottom: insets.bottom + 100,
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingTop: Platform.OS === 'ios' ? 16 : 24,
      paddingBottom: 20,
    },
    teamName: {
      fontSize: 24,
      fontFamily: 'Inter_700Bold',
      color: colors.foreground,
    },
    season: { fontSize: 13, color: colors.mutedForeground, fontFamily: 'Inter_400Regular', marginTop: 2 },
    recordBtn: {
      width: 40,
      height: 40,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
    },
    statsRow: { flexDirection: 'row', marginBottom: 24 },
    sectionTitle: {
      fontSize: 12,
      fontFamily: 'Inter_600SemiBold',
      color: colors.mutedForeground,
      letterSpacing: 1,
      textTransform: 'uppercase',
      marginBottom: 10,
      marginTop: 4,
    },
    performerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      borderRadius: 10,
      borderWidth: 1,
      paddingHorizontal: 14,
      paddingVertical: 12,
      marginBottom: 6,
      gap: 10,
    },
    performerRank: { fontSize: 20, width: 30, lineHeight: 22 },
    performerName: { flex: 1, fontSize: 15, fontFamily: 'Inter_600SemiBold' },
    performerStat: { fontSize: 14, fontFamily: 'Inter_500Medium' },
    emptyTitle: {
      fontSize: 20,
      fontFamily: 'Inter_600SemiBold',
      color: colors.foreground,
      marginTop: 16,
      marginBottom: 8,
    },
    emptyBody: {
      fontSize: 14,
      color: colors.mutedForeground,
      textAlign: 'center',
      maxWidth: 260,
      fontFamily: 'Inter_400Regular',
      lineHeight: 20,
    },
    emptyGames: { alignItems: 'center', paddingTop: 32, paddingBottom: 16 },
  });
}
