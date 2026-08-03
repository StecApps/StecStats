import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Platform,
} from 'react-native';
import Svg, { Circle, G } from 'react-native-svg';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import {
  useListPlayers,
  useGetPlayerSummary,
  useListTeams,
} from '@workspace/api-client-react';
import { Ionicons } from '@expo/vector-icons';

// ─── Arc Gauge ─────────────────────────────────────────────────────────────
function ArcGauge({
  pct,
  label,
  made,
  attempted,
  colors,
}: {
  pct?: number | null;
  label: string;
  made?: number;
  attempted?: number;
  colors: any;
}) {
  const SIZE = 84;
  const SW = 7;
  const r = (SIZE - SW) / 2;
  const circ = 2 * Math.PI * r;
  const filled = Math.max(0, Math.min(1, pct ?? 0)) * circ;
  const pctStr = pct != null && pct > 0 ? (pct * 100).toFixed(1) : '—';

  return (
    <View style={gaugeS.wrap}>
      <View style={{ width: SIZE, height: SIZE }}>
        <Svg width={SIZE} height={SIZE}>
          <G rotation="-90" origin={`${SIZE / 2},${SIZE / 2}`}>
            <Circle
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={r}
              stroke={colors.muted}
              strokeWidth={SW}
              fill="none"
            />
            <Circle
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={r}
              stroke={colors.primary}
              strokeWidth={SW}
              fill="none"
              strokeDasharray={`${filled} ${circ}`}
              strokeLinecap="round"
            />
          </G>
        </Svg>
        <View style={gaugeS.center}>
          <Text style={[gaugeS.pctNum, { color: colors.foreground, fontFamily: 'Teko_700Bold' }]}>
            {pctStr}
          </Text>
          {pct != null && pct > 0 && (
            <Text style={[gaugeS.pctLabel, { color: colors.mutedForeground }]}>PERCENT</Text>
          )}
        </View>
      </View>
      <Text style={[gaugeS.gaugeLabel, { color: colors.mutedForeground }]}>{label}</Text>
      {made != null && attempted != null && (
        <Text style={[gaugeS.made, { color: colors.mutedForeground }]}>
          {made} / {attempted}
        </Text>
      )}
    </View>
  );
}

const gaugeS = StyleSheet.create({
  wrap: { alignItems: 'center', flex: 1 },
  center: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pctNum: { fontSize: 17, lineHeight: 19 },
  pctLabel: { fontSize: 7, fontFamily: 'Inter_500Medium', letterSpacing: 0.3 },
  gaugeLabel: {
    fontSize: 10,
    fontFamily: 'Inter_500Medium',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginTop: 6,
  },
  made: { fontSize: 11, fontFamily: 'Inter_400Regular', marginTop: 2 },
});

// ─── Player Chip ───────────────────────────────────────────────────────────
function PlayerChip({
  player,
  isSelected,
  onPress,
  colors,
}: {
  player: any;
  isSelected: boolean;
  onPress: () => void;
  colors: any;
}) {
  const { data: summary } = useGetPlayerSummary(player.id);
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.75}
      style={[
        chipS.chip,
        {
          backgroundColor: isSelected ? colors.primary : colors.card,
          borderColor: isSelected ? colors.primary : colors.border,
        },
      ]}
    >
      <Text style={[chipS.name, { color: isSelected ? '#fff' : colors.foreground }]}>
        {player.name}
      </Text>
      <Text style={[chipS.sub, { color: isSelected ? 'rgba(255,255,255,0.7)' : colors.mutedForeground }]}>
        {summary ? `${summary.games}GP · ${summary.ppg.toFixed(1)}PPG` : '…'}
      </Text>
    </TouchableOpacity>
  );
}

const chipS = StyleSheet.create({
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 22,
    borderWidth: 1,
    marginRight: 8,
    minWidth: 110,
  },
  name: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  sub: { fontSize: 11, fontFamily: 'Inter_400Regular', marginTop: 2 },
});

// ─── Stat Card ─────────────────────────────────────────────────────────────
function StatCard({
  label,
  value,
  sub,
  colors,
}: {
  label: string;
  value: string;
  sub?: string;
  colors: any;
}) {
  return (
    <View style={[statS.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Text style={[statS.label, { color: colors.mutedForeground }]}>{label}</Text>
      <Text style={[statS.value, { color: colors.primary, fontFamily: 'Teko_700Bold' }]}>
        {value}
      </Text>
      {sub && <Text style={[statS.sub, { color: colors.mutedForeground }]}>{sub}</Text>}
    </View>
  );
}

const statS = StyleSheet.create({
  card: {
    flex: 1,
    borderRadius: 10,
    borderWidth: 1,
    padding: 12,
    alignItems: 'center',
  },
  label: {
    fontSize: 9,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginBottom: 4,
    textAlign: 'center',
  },
  value: { fontSize: 30, lineHeight: 32 },
  sub: { fontSize: 10, fontFamily: 'Inter_400Regular', marginTop: 2, textAlign: 'center' },
});

// ─── Mini Stat ──────────────────────────────────────────────────────────────
function MiniStat({ label, value, total, colors }: { label: string; value: string; total?: string; colors: any }) {
  return (
    <View style={[miniS.wrap, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Text style={[miniS.label, { color: colors.mutedForeground }]}>{label}</Text>
      <Text style={[miniS.value, { color: colors.foreground, fontFamily: 'Teko_700Bold' }]}>
        {value}
      </Text>
      {total && (
        <Text style={[miniS.total, { color: colors.mutedForeground }]}>{total} TOTAL</Text>
      )}
    </View>
  );
}

const miniS = StyleSheet.create({
  wrap: {
    flex: 1,
    borderRadius: 10,
    borderWidth: 1,
    padding: 12,
    alignItems: 'center',
  },
  label: {
    fontSize: 9,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginBottom: 4,
    textAlign: 'center',
  },
  value: { fontSize: 26, lineHeight: 28 },
  total: { fontSize: 9, fontFamily: 'Inter_400Regular', marginTop: 2 },
});

// ─── Section Header ────────────────────────────────────────────────────────
function SectionHeader({ title, colors }: { title: string; colors: any }) {
  return (
    <View style={secS.wrap}>
      <View style={[secS.bar, { backgroundColor: colors.primary }]} />
      <Text style={[secS.title, { color: colors.foreground }]}>{title}</Text>
    </View>
  );
}

const secS = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'center', marginBottom: 12, marginTop: 20 },
  bar: { width: 3, height: 18, borderRadius: 2, marginRight: 10 },
  title: { fontSize: 13, fontFamily: 'Inter_700Bold', letterSpacing: 1, textTransform: 'uppercase' },
});

// ─── Player Dashboard ──────────────────────────────────────────────────────
function PlayerDashboard({ player, colors }: { player: any; colors: any }) {
  const { data: summary, isLoading } = useGetPlayerSummary(player.id);

  if (isLoading || !summary) {
    return (
      <View style={{ paddingVertical: 40, alignItems: 'center' }}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  const fgMade = summary.twoMade + summary.threeMade;
  const fgAtt = summary.twoAttempted + summary.threeAttempted;
  const winRate = summary.games > 0 ? Math.round((summary.wins / summary.games) * 100) : 0;

  return (
    <>
      {/* Player Hero */}
      <View style={[heroS.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={heroS.flashRow}>
          <Ionicons name="flash" size={14} color={colors.primary} />
          <Text style={[heroS.liveLabel, { color: colors.primary }]}>LIVE PLAYER STATS</Text>
          <Ionicons name="flash" size={14} color={colors.primary} />
        </View>

        <View style={[heroS.avatar, { borderColor: colors.primary, backgroundColor: colors.primary + '20' }]}>
          <Text style={[heroS.avatarText, { color: colors.primary, fontFamily: 'Teko_700Bold' }]}>
            {player.name.split(' ').map((w: string) => w[0]).join('').slice(0, 2).toUpperCase()}
          </Text>
        </View>

        <Text style={[heroS.playerName, { color: colors.foreground, fontFamily: 'Teko_700Bold' }]}>
          {player.name.toUpperCase()}
        </Text>

        <View style={[heroS.scopeBadge, { backgroundColor: colors.muted }]}>
          <Text style={[heroS.scopeText, { color: colors.mutedForeground }]}>
            {summary.seasonScope === 'career' ? '● CAREER SUMMARY DASHBOARD' : '● CURRENT SEASON SUMMARY'}
          </Text>
        </View>
      </View>

      {/* 4 Stat Cards */}
      <View style={{ flexDirection: 'row', gap: 6, marginBottom: 6 }}>
        <StatCard label="Points / GM" value={summary.ppg.toFixed(1)} sub={`${summary.points} TOTAL`} colors={colors} />
        <StatCard label="Games Played" value={String(summary.games)} sub={`${summary.wins}W · ${summary.losses}L`} colors={colors} />
      </View>
      <View style={{ flexDirection: 'row', gap: 6 }}>
        <StatCard label="Win Record" value={`${summary.wins}-${summary.losses}`} sub={`${winRate}% WIN RATE`} colors={colors} />
        <StatCard label="Rebounds / GM" value={summary.rpg.toFixed(1)} sub={`${summary.rebounds} TOTAL`} colors={colors} />
      </View>

      {/* Shooting Efficiency */}
      <SectionHeader title="Shooting Efficiency" colors={colors} />
      <View style={[shootS.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <ArcGauge
          pct={fgAtt > 0 ? fgMade / fgAtt : null}
          label="Field Goal"
          made={fgMade}
          attempted={fgAtt}
          colors={colors}
        />
        <View style={[shootS.divider, { backgroundColor: colors.border }]} />
        <ArcGauge
          pct={summary.threeAttempted > 0 ? summary.threeMade / summary.threeAttempted : null}
          label="3-Point"
          made={summary.threeMade}
          attempted={summary.threeAttempted}
          colors={colors}
        />
        <View style={[shootS.divider, { backgroundColor: colors.border }]} />
        <ArcGauge
          pct={summary.ftAttempted > 0 ? summary.ftMade / summary.ftAttempted : null}
          label="Free Throw"
          made={summary.ftMade}
          attempted={summary.ftAttempted}
          colors={colors}
        />
      </View>

      {/* Playmaking & Defense */}
      <SectionHeader title="Playmaking & Defense" colors={colors} />
      <View style={{ flexDirection: 'row', gap: 6, marginBottom: 6 }}>
        <MiniStat label="Assists / GM" value={summary.apg.toFixed(1)} total={String(summary.assists)} colors={colors} />
        <MiniStat label="Steals / GM" value={summary.spg.toFixed(1)} total={String(summary.steals)} colors={colors} />
      </View>
      <View style={{ flexDirection: 'row', gap: 6 }}>
        <MiniStat label="Blocks / GM" value={summary.bpg.toFixed(1)} total={String(summary.blocks)} colors={colors} />
        <MiniStat label="Turnovers / GM" value={summary.topg.toFixed(1)} total={String(summary.turnovers)} colors={colors} />
      </View>
    </>
  );
}

const heroS = StyleSheet.create({
  card: {
    borderRadius: 14,
    borderWidth: 1,
    alignItems: 'center',
    paddingVertical: 20,
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  flashRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 14 },
  liveLabel: { fontSize: 11, fontFamily: 'Inter_700Bold', letterSpacing: 1.5 },
  avatar: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 3,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  avatarText: { fontSize: 28, lineHeight: 32 },
  playerName: { fontSize: 34, lineHeight: 38, letterSpacing: 1 },
  scopeBadge: {
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 10,
  },
  scopeText: { fontSize: 10, fontFamily: 'Inter_500Medium', letterSpacing: 0.5 },
});

const shootS = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
    gap: 0,
  },
  divider: { width: 1, alignSelf: 'stretch', marginHorizontal: 8 },
});

// ─── Main Screen ────────────────────────────────────────────────────────────
export default function DashboardScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const { data: players, isLoading: playersLoading, refetch: refetchPlayers } = useListPlayers();
  const { data: teams } = useListTeams();
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const activeId = selectedId ?? (players?.[0] as any)?.id ?? null;
  const activePlayer = (players as any[])?.find((p) => p.id === activeId) ?? null;

  const isLoading = playersLoading;

  const styles = makeStyles(colors, insets);

  if (isLoading) {
    return (
      <View style={[styles.root, styles.centered]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (!players?.length) {
    return (
      <View style={[styles.root, styles.centered]}>
        <Ionicons name="basketball-outline" size={52} color={colors.mutedForeground} />
        <Text style={styles.emptyTitle}>No players yet</Text>
        <Text style={styles.emptySub}>Add players from the Profile tab to start tracking stats.</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl
          refreshing={false}
          onRefresh={refetchPlayers}
          tintColor={colors.primary}
        />
      }
    >
      {/* Player chip selector */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chips}
      >
        {(players as any[]).map((p) => (
          <PlayerChip
            key={p.id}
            player={p}
            isSelected={p.id === activeId}
            onPress={() => setSelectedId(p.id)}
            colors={colors}
          />
        ))}
      </ScrollView>

      {/* Player stats */}
      {activePlayer ? (
        <PlayerDashboard player={activePlayer} colors={colors} />
      ) : (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.primary} />
        </View>
      )}
    </ScrollView>
  );
}

function makeStyles(colors: any, insets: any) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    content: {
      paddingTop: insets.top + (Platform.OS === 'web' ? 67 : Platform.OS === 'ios' ? 16 : 24),
      paddingHorizontal: 16,
      paddingBottom: insets.bottom + 100,
    },
    chips: {
      paddingBottom: 16,
    },
    emptyTitle: {
      fontSize: 20,
      fontFamily: 'Inter_700Bold',
      color: colors.foreground,
      marginTop: 16,
      marginBottom: 8,
    },
    emptySub: {
      fontSize: 14,
      color: colors.mutedForeground,
      textAlign: 'center',
      maxWidth: 260,
      fontFamily: 'Inter_400Regular',
      lineHeight: 20,
    },
  });
}
