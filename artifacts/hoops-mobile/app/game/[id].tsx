import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  FlatList,
  Platform,
} from 'react-native';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  useGetGame,
  useGetGameHighlight,
  useGenerateGameHighlight,
} from '@workspace/api-client-react';
import { useLayoutEffect } from 'react';
import { Ionicons, Feather } from '@expo/vector-icons';
import { tekoStyle } from '@/lib/tekoStyle';
import { VideoView, useVideoPlayer } from 'expo-video';
import { useAuth } from '@clerk/clerk-expo';

const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}`
  : '';

async function fetchSignedUrl(objectPath: string, token: string): Promise<string> {
  const clean = objectPath.replace(/^\/objects\//, '');
  const res = await fetch(`${API_BASE}/api/storage/objects-signed-url/${clean}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error('Could not get signed URL');
  const { url } = await res.json();
  return url;
}

type Tab = 'stats' | 'video' | 'highlights';

function StatPill({
  label,
  value,
  colors,
}: {
  label: string;
  value: number;
  colors: any;
}) {
  return (
    <View style={[pillStyle.wrap, { backgroundColor: colors.muted }]}>
      <Text style={[pillStyle.value, { color: colors.foreground }]}>
        {value}
      </Text>
      <Text style={[pillStyle.label, { color: colors.mutedForeground }]}>{label}</Text>
    </View>
  );
}

const pillStyle = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    minWidth: 46,
  },
  value: { ...tekoStyle(20, 'semiBold') },
  label: { fontSize: 9, textTransform: 'uppercase', fontFamily: 'Inter_500Medium', letterSpacing: 0.5 },
});

function VideoSection({ game, colors }: { game: any; colors: any }) {
  const { getToken } = useAuth();
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);

  const player = useVideoPlayer('', () => {});

  useEffect(() => {
    if (!game.videoObjectPath) return;
    let cancelled = false;
    getToken()
      .then((token) => {
        if (!token || cancelled) return;
        return fetchSignedUrl(game.videoObjectPath, token);
      })
      .then((url) => {
        if (!url || cancelled) return;
        setSignedUrl(url);
        player.replace({ uri: url });
      })
      .catch(() => { if (!cancelled) setLoadError(true); });
    return () => { cancelled = true; };
  }, [game.videoObjectPath]);

  if (!game.videoObjectPath) {
    return (
      <View style={videoStyle.empty}>
        <Ionicons name="videocam-off-outline" size={40} color={colors.mutedForeground} />
        <Text style={[videoStyle.emptyText, { color: colors.mutedForeground }]}>
          No video recorded for this game
        </Text>
      </View>
    );
  }

  if (loadError) {
    return (
      <View style={videoStyle.empty}>
        <Ionicons name="alert-circle-outline" size={40} color={colors.mutedForeground} />
        <Text style={[videoStyle.emptyText, { color: colors.mutedForeground }]}>
          Could not load video
        </Text>
      </View>
    );
  }

  if (!signedUrl) {
    return <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />;
  }

  return (
    <View style={videoStyle.wrap}>
      <VideoView
        player={player}
        style={videoStyle.video}
        allowsFullscreen
        allowsPictureInPicture
      />
    </View>
  );
}

const videoStyle = StyleSheet.create({
  wrap: { marginHorizontal: 16, marginTop: 16, borderRadius: 12, overflow: 'hidden' },
  video: { width: '100%', aspectRatio: 16 / 9, backgroundColor: '#000' },
  empty: { alignItems: 'center', paddingTop: 60, gap: 12 },
  emptyText: { fontSize: 15, fontFamily: 'Inter_400Regular' },
});

function HighlightSection({ gameId, colors }: { gameId: number; colors: any }) {
  const { getToken } = useAuth();
  const { data: highlight, refetch } = useGetGameHighlight(gameId);
  const generateMutation = useGenerateGameHighlight();
  const [signedUrl, setSignedUrl] = useState<string | null>(null);

  const player = useVideoPlayer('', () => {});

  const objectPath = highlight?.status === 'ready' ? highlight.highlightObjectPath ?? null : null;

  useEffect(() => {
    if (!objectPath) return;
    let cancelled = false;
    getToken()
      .then((token) => {
        if (!token || cancelled) return;
        return fetchSignedUrl(objectPath, token);
      })
      .then((url) => {
        if (!url || cancelled) return;
        setSignedUrl(url);
        player.replace({ uri: url });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [objectPath]);

  if (!highlight) return <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />;

  if (highlight.status === 'ready') {
    if (!signedUrl) return <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />;
    return (
      <View style={videoStyle.wrap}>
        <VideoView
          player={player}
          style={videoStyle.video}
          allowsFullscreen
          allowsPictureInPicture
        />
      </View>
    );
  }

  if (highlight.status === 'processing') {
    return (
      <View style={videoStyle.empty}>
        <ActivityIndicator color={colors.primary} size="large" />
        <Text style={[videoStyle.emptyText, { color: colors.mutedForeground }]}>
          Generating highlight reel…
        </Text>
      </View>
    );
  }

  return (
    <View style={videoStyle.empty}>
      <Ionicons name="film-outline" size={40} color={colors.mutedForeground} />
      <Text style={[videoStyle.emptyText, { color: colors.mutedForeground }]}>
        {highlight.eligibleMoments > 0
          ? `${highlight.eligibleMoments} highlight moments ready to clip`
          : 'No highlight moments recorded'}
      </Text>
      {highlight.eligibleMoments > 0 && (
        <TouchableOpacity
          onPress={async () => {
            await generateMutation.mutateAsync({ gameId });
            refetch();
          }}
          style={{ backgroundColor: colors.primary, borderRadius: 10, paddingHorizontal: 20, paddingVertical: 12, marginTop: 8 }}
          activeOpacity={0.8}
          disabled={generateMutation.isPending}
        >
          <Text style={{ color: '#fff', fontFamily: 'Inter_600SemiBold', fontSize: 15 }}>
            {generateMutation.isPending ? 'Starting…' : 'Generate Highlights'}
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

export default function GameDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const gameId = Number(id);
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const [tab, setTab] = useState<Tab>('stats');

  const { data: game, isLoading } = useGetGame(gameId);

  useLayoutEffect(() => {
    if (game) {
      navigation.setOptions({
        title: `vs ${game.opponent}`,
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.foreground,
        headerShadowVisible: false,
      });
    }
  }, [game, navigation, colors]);

  const styles = makeStyles(colors, insets);

  if (isLoading) {
    return (
      <View style={[styles.root, styles.centered]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (!game) {
    return (
      <View style={[styles.root, styles.centered]}>
        <Text style={[styles.error, { color: colors.destructive }]}>Game not found</Text>
      </View>
    );
  }

  const isWin = game.result === 'W';

  return (
    <View style={styles.root}>
      {/* Score header */}
      <View style={[styles.scoreCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={styles.scoreBlock}>
          <Text style={[styles.scoreName, { color: colors.mutedForeground }]} numberOfLines={2} ellipsizeMode="tail">
            {game.teamName}
          </Text>
          <Text style={[styles.scoreNum, { color: colors.foreground }]}>
            {game.teamScore}
          </Text>
        </View>
        <View style={styles.scoreDivider}>
          <View style={[styles.resultBadge, { backgroundColor: isWin ? colors.primary : colors.muted }]}>
            <Text style={[styles.resultText, { color: isWin ? '#fff' : colors.mutedForeground }]}>
              {isWin ? 'W' : 'L'}
            </Text>
          </View>
          <Text style={[styles.scoreDate, { color: colors.mutedForeground }]}>
            {new Date(game.date).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' })}
          </Text>
        </View>
        <View style={styles.scoreBlock}>
          <Text style={[styles.scoreName, { color: colors.mutedForeground }]} numberOfLines={2} ellipsizeMode="tail">
            {game.opponent}
          </Text>
          <Text style={[styles.scoreNum, { color: colors.foreground }]}>
            {game.opponentScore}
          </Text>
        </View>
      </View>

      {/* Tabs */}
      <View style={[styles.tabBar, { backgroundColor: colors.card, borderColor: colors.border }]}>
        {(['stats', 'video', 'highlights'] as Tab[]).map((t) => (
          <TouchableOpacity
            key={t}
            onPress={() => setTab(t)}
            style={[styles.tabBtn, tab === t && { borderBottomColor: colors.primary, borderBottomWidth: 2 }]}
            activeOpacity={0.7}
          >
            <Text
              style={[
                styles.tabText,
                { color: tab === t ? colors.primary : colors.mutedForeground },
              ]}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Content */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: insets.bottom + 30 }}
        showsVerticalScrollIndicator={false}
      >
        {tab === 'stats' && (
          <>
            {(game.stats as any[]).length === 0 ? (
              <View style={videoStyle.empty}>
                <Ionicons name="stats-chart-outline" size={40} color={colors.mutedForeground} />
                <Text style={[videoStyle.emptyText, { color: colors.mutedForeground }]}>
                  No player stats recorded
                </Text>
              </View>
            ) : (
              (game.stats as any[]).map((stat: any) => (
                <View
                  key={stat.playerId}
                  style={[styles.statRow, { backgroundColor: colors.card, borderColor: colors.border }]}
                >
                  <Text style={[styles.playerName, { color: colors.foreground }]} numberOfLines={1}>
                    {stat.playerName}
                  </Text>
                  <View style={styles.pills}>
                    <StatPill label="PTS" value={stat.points} colors={colors} />
                    <StatPill label="REB" value={stat.rebounds} colors={colors} />
                    <StatPill label="AST" value={stat.assists} colors={colors} />
                    <StatPill label="STL" value={stat.steals} colors={colors} />
                    <StatPill label="BLK" value={stat.blocks} colors={colors} />
                  </View>
                </View>
              ))
            )}
          </>
        )}
        {tab === 'video' && <VideoSection game={game} colors={colors} />}
        {tab === 'highlights' && <HighlightSection gameId={gameId} colors={colors} />}
      </ScrollView>
    </View>
  );
}

function makeStyles(colors: any, insets: any) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    centered: { alignItems: 'center', justifyContent: 'center' },
    error: { fontSize: 16, fontFamily: 'Inter_400Regular' },
    scoreCard: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      margin: 16,
      borderRadius: 14,
      borderWidth: 1,
      paddingHorizontal: 20,
      paddingVertical: 18,
    },
    scoreBlock: { alignItems: 'center', flex: 1, minWidth: 0 },
    scoreName: { fontSize: 11, fontFamily: 'Inter_500Medium', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.4, textAlign: 'center' },
    scoreNum: { ...tekoStyle(44) },
    scoreDivider: { alignItems: 'center', gap: 6 },
    resultBadge: { width: 36, height: 28, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
    resultText: { fontSize: 13, fontFamily: 'Inter_700Bold' },
    scoreDate: { fontSize: 12, fontFamily: 'Inter_400Regular' },
    tabBar: {
      flexDirection: 'row',
      borderBottomWidth: 1,
      marginHorizontal: 16,
      borderTopLeftRadius: 10,
      borderTopRightRadius: 10,
    },
    tabBtn: {
      flex: 1,
      alignItems: 'center',
      paddingVertical: 12,
    },
    tabText: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
    statRow: {
      marginHorizontal: 16,
      marginTop: 10,
      borderRadius: 12,
      borderWidth: 1,
      padding: 14,
      gap: 10,
    },
    playerName: { fontSize: 15, fontFamily: 'Inter_600SemiBold' },
    pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  });
}
