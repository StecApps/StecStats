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
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useListPlayers, useCreateGame } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';

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

type StatButtonDef = {
  label: string;
  sub?: string;
  color: 'primary' | 'muted' | 'destructive';
  onPress: (line: StatLine) => Partial<StatLine>;
  mainField: string;
};

function makeStatButtons(colors: any): StatButtonDef[] {
  return [
    {
      label: '+2', sub: 'Made', color: 'primary', mainField: 'twoMade',
      onPress: (s) => ({ twoMade: s.twoMade + 1, twoAttempted: s.twoAttempted + 1 }),
    },
    {
      label: '+3', sub: 'Made', color: 'primary', mainField: 'threeMade',
      onPress: (s) => ({ threeMade: s.threeMade + 1, threeAttempted: s.threeAttempted + 1 }),
    },
    {
      label: 'Miss', sub: '2pt', color: 'muted', mainField: 'twoAttempted',
      onPress: (s) => ({ twoAttempted: s.twoAttempted + 1 }),
    },
    {
      label: 'Miss', sub: '3pt', color: 'muted', mainField: 'threeAttempted',
      onPress: (s) => ({ threeAttempted: s.threeAttempted + 1 }),
    },
    {
      label: 'FT', sub: 'Made', color: 'primary', mainField: 'ftMade',
      onPress: (s) => ({ ftMade: s.ftMade + 1, ftAttempted: s.ftAttempted + 1 }),
    },
    {
      label: 'FT', sub: 'Miss', color: 'muted', mainField: 'ftAttempted',
      onPress: (s) => ({ ftAttempted: s.ftAttempted + 1 }),
    },
    {
      label: 'Assist', color: 'primary', mainField: 'assists',
      onPress: (s) => ({ assists: s.assists + 1 }),
    },
    {
      label: 'Rebound', color: 'primary', mainField: 'rebounds',
      onPress: (s) => ({ rebounds: s.rebounds + 1 }),
    },
    {
      label: 'Steal', color: 'primary', mainField: 'steals',
      onPress: (s) => ({ steals: s.steals + 1 }),
    },
    {
      label: 'Block', color: 'primary', mainField: 'blocks',
      onPress: (s) => ({ blocks: s.blocks + 1 }),
    },
    {
      label: 'Turnover', color: 'destructive', mainField: 'turnovers',
      onPress: (s) => ({ turnovers: s.turnovers + 1 }),
    },
  ];
}

function calcPoints(line: StatLine): number {
  return line.twoMade * 2 + line.threeMade * 3 + line.ftMade;
}

function formatTime(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function ScorekeeperScreen() {
  const { opponent = 'Opponent', teamId = '0', teamName = 'Your Team', date = new Date().toISOString().split('T')[0] } =
    useLocalSearchParams<{ opponent: string; teamId: string; teamName: string; date: string }>();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const qc = useQueryClient();
  const createGame = useCreateGame();

  const { data: players, isLoading: playersLoading } = useListPlayers();
  const [selectedPlayerId, setSelectedPlayerId] = useState<number | null>(null);
  const [stats, setStats] = useState<Record<number, StatLine>>({});
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [opponentScore, setOpponentScore] = useState(0);
  const [half, setHalf] = useState<1 | 2>(1);
  const [seconds, setSeconds] = useState(0);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startRef = useRef<number>(0);
  const statButtons = makeStatButtons(colors);

  // Init stats for all players
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

  function handleStartStop() {
    if (!running) {
      if (seconds === 0) startRef.current = Date.now();
      setRunning(true);
    } else {
      setRunning(false);
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  }

  function handleStatPress(btn: StatButtonDef) {
    if (!selectedPlayerId) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const timestamp = running ? Date.now() - startRef.current : seconds * 1000;
    setStats((prev) => {
      const line = prev[selectedPlayerId] ?? defaultLine();
      return { ...prev, [selectedPlayerId]: { ...line, ...btn.onPress(line) } };
    });
    setEvents((prev) => [
      ...prev,
      { playerId: selectedPlayerId, statField: btn.mainField, delta: 1, videoTimestampMs: timestamp },
    ]);
  }

  const teamScore = Object.values(stats).reduce((sum, line) => sum + calcPoints(line), 0);

  async function handleSave() {
    if (saving) return;
    if (!players || (players as any[]).length === 0) {
      Alert.alert('No players', 'Add players to your team before saving a game.');
      return;
    }
    setSaving(true);
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

  const styles = makeStyles(colors, insets);

  if (playersLoading) {
    return (
      <View style={[styles.root, styles.centered]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      {/* Header: scores */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.closeBtn}>
          <Ionicons name="chevron-down" size={24} color={colors.mutedForeground} />
        </TouchableOpacity>

        <View style={styles.scoreboard}>
          {/* Our score */}
          <View style={styles.scoreCol}>
            <Text style={[styles.teamLabel, { color: colors.mutedForeground }]} numberOfLines={1}>
              {teamName}
            </Text>
            <Text style={[styles.scoreNum, { color: colors.foreground, fontFamily: 'Teko_700Bold' }]}>
              {teamScore}
            </Text>
          </View>

          {/* Center: timer + half */}
          <View style={styles.scoreCenter}>
            <Text style={[styles.timer, { color: colors.mutedForeground, fontFamily: 'Teko_400Regular' }]}>
              {formatTime(seconds)}
            </Text>
            <TouchableOpacity
              onPress={handleStartStop}
              style={[styles.timerBtn, { backgroundColor: running ? colors.muted : colors.primary }]}
            >
              <Ionicons name={running ? 'pause' : 'play'} size={14} color={running ? colors.mutedForeground : '#fff'} />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => {
                setHalf((h) => (h === 1 ? 2 : 1));
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              }}
              style={[styles.halfBtn, { borderColor: colors.border }]}
            >
              <Text style={[styles.halfText, { color: colors.mutedForeground }]}>{half === 1 ? '1st' : '2nd'}</Text>
            </TouchableOpacity>
          </View>

          {/* Opponent score */}
          <View style={styles.scoreCol}>
            <Text style={[styles.teamLabel, { color: colors.mutedForeground }]} numberOfLines={1}>
              {opponent}
            </Text>
            <View style={styles.oppScoreRow}>
              <TouchableOpacity
                onPress={() => { setOpponentScore((s) => Math.max(0, s - 1)); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
                style={[styles.oppBtn, { backgroundColor: colors.muted }]}
              >
                <Text style={[styles.oppBtnText, { color: colors.mutedForeground }]}>−</Text>
              </TouchableOpacity>
              <Text style={[styles.scoreNum, { color: colors.foreground, fontFamily: 'Teko_700Bold' }]}>
                {opponentScore}
              </Text>
              <TouchableOpacity
                onPress={() => { setOpponentScore((s) => s + 1); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
                style={[styles.oppBtn, { backgroundColor: colors.muted }]}
              >
                <Text style={[styles.oppBtnText, { color: colors.mutedForeground }]}>+</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </View>

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

      {/* Stat buttons */}
      <View style={styles.grid}>
        {statButtons.map((btn, i) => {
          const bgColor =
            btn.color === 'primary'
              ? colors.primary + '18'
              : btn.color === 'destructive'
              ? colors.destructive + '18'
              : colors.muted;
          const textColor =
            btn.color === 'primary'
              ? colors.primary
              : btn.color === 'destructive'
              ? colors.destructive
              : colors.mutedForeground;
          return (
            <TouchableOpacity
              key={i}
              onPress={() => handleStatPress(btn)}
              activeOpacity={0.7}
              disabled={!selectedPlayerId}
              style={[
                styles.statBtn,
                { backgroundColor: bgColor, borderColor: textColor + '30' },
                !selectedPlayerId && { opacity: 0.3 },
              ]}
            >
              <Text style={[styles.statBtnLabel, { color: textColor }]}>{btn.label}</Text>
              {btn.sub && (
                <Text style={[styles.statBtnSub, { color: textColor + 'AA' }]}>{btn.sub}</Text>
              )}
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Save button */}
      <View style={[styles.footer, { paddingBottom: insets.bottom + 16 }]}>
        <TouchableOpacity
          onPress={confirmSave}
          disabled={saving}
          activeOpacity={0.8}
          style={[styles.saveBtn, { backgroundColor: colors.primary }]}
        >
          {saving ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <>
              <Ionicons name="checkmark-circle" size={20} color="#fff" />
              <Text style={styles.saveBtnText}>Save Game</Text>
            </>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

function makeStyles(colors: any, insets: any) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    centered: { alignItems: 'center', justifyContent: 'center' },
    header: {
      paddingTop: insets.top + (Platform.OS === 'web' ? 67 : (Platform.OS === 'ios' ? 12 : 16)),
      paddingBottom: 12,
      paddingHorizontal: 12,
    },
    closeBtn: { alignSelf: 'center', padding: 6, marginBottom: 4 },
    scoreboard: { flexDirection: 'row', alignItems: 'center' },
    scoreCol: { flex: 1, alignItems: 'center' },
    teamLabel: { fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2, fontFamily: 'Inter_500Medium', maxWidth: 100 },
    scoreNum: { fontSize: 56, lineHeight: 58 },
    scoreCenter: { alignItems: 'center', gap: 6, paddingHorizontal: 8 },
    timer: { fontSize: 22, lineHeight: 24 },
    timerBtn: {
      width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center',
    },
    halfBtn: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
    halfText: { fontSize: 12, fontFamily: 'Inter_600SemiBold' },
    oppScoreRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    oppBtn: { width: 26, height: 26, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
    oppBtnText: { fontSize: 18, lineHeight: 20, fontFamily: 'Inter_600SemiBold' },
    playerBar: {
      borderTopWidth: 1,
      borderBottomWidth: 1,
      paddingVertical: 10,
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
    grid: {
      flex: 1,
      flexDirection: 'row',
      flexWrap: 'wrap',
      padding: 10,
      gap: 8,
    },
    statBtn: {
      width: '29%',
      flexGrow: 1,
      minHeight: 60,
      borderRadius: 10,
      borderWidth: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: 8,
    },
    statBtnLabel: { fontSize: 15, fontFamily: 'Inter_700Bold' },
    statBtnSub: { fontSize: 11, fontFamily: 'Inter_400Regular', marginTop: 1 },
    footer: {
      paddingHorizontal: 16,
      paddingTop: 8,
      borderTopWidth: 1,
      borderTopColor: 'rgba(255,255,255,0.06)',
    },
    saveBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      height: 52,
      borderRadius: 13,
    },
    saveBtnText: { fontSize: 16, fontFamily: 'Inter_700Bold', color: '#fff' },
  });
}
