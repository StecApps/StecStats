import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  FlatList,
  Platform,
  useWindowDimensions,
  Modal,
  TextInput,
  Alert,
  Linking,
  Share,
  KeyboardAvoidingView,
  Pressable,
} from 'react-native';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  useGetGame,
  useGetGameHighlight,
  useGenerateGameHighlight,
  useGetGameLowlight,
  useGenerateGameLowlight,
} from '@workspace/api-client-react';
import { useLayoutEffect } from 'react';
import { Ionicons, Feather } from '@expo/vector-icons';
import { tekoStyle } from '@/lib/tekoStyle';
import { saveReviewVideo } from '@/lib/saveReviewVideo';
import { setVideoCacheSizeAsync, VideoView, useVideoPlayer } from 'expo-video';
import { useAuth } from '@clerk/expo';
import { ZoomableVideo } from '@/components/ZoomableVideo';
import { reelDownloadManager, useReelDownloads } from '@/lib/reelDownloadManager';

const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}`
  : '';

// Expo Video defaults to a 1 GB LRU cache. A single full-game recording can
// approach that size, which caused previously watched footage to be evicted
// almost immediately. This setting is persistent and does not pre-download
// anything; it only gives already-requested video ranges room to stay cached.
if (Platform.OS !== 'web') {
  setVideoCacheSizeAsync(3 * 1024 * 1024 * 1024).catch(() => {
    // During Fast Refresh an existing player can briefly prevent resizing.
    // The last successful value is persistent, so playback can continue.
  });
}

async function fetchStreamUrl(
  gameId: number,
  type: 'video' | 'highlight' | 'lowlight',
  token: string,
): Promise<{ url: string; proxyReady: boolean; proxySkipped: boolean; isHls: boolean }> {
  const res = await fetch(`${API_BASE}/api/games/${gameId}/stream-token/${type}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error('Could not get stream token');
  const { token: streamToken, proxyReady, proxySkipped, proxyType, streamUrl } = await res.json();

  // proxyType==='hls' → long game served as an HLS playlist backed by proxy
  // chunks; AVPlayer on iOS handles M3U8 natively.  Use the playlist URL
  // directly instead of the single-file stream endpoint.
  //
  // For non-HLS streams the server returns a pre-generated `streamUrl` (a
  // 5 h GCS signed URL).  Passing it directly to expo-video means ALL seeks
  // — including HTTP Range requests — go to GCS without touching the server.
  // This avoids relying on AVPlayer retaining the 302 redirect target across
  // Range seeks (unspecified behaviour), and means the 4 h stream token is
  // irrelevant for playback: the GCS URL stays valid for 1 h after the token
  // expires so the coach can seek freely throughout a long review session.
  const url = proxyType === 'hls'
    ? `${API_BASE}/api/games/${gameId}/hls/playlist.m3u8?t=${streamToken}`
    : (streamUrl ?? `${API_BASE}/api/games/${gameId}/stream/${type}?t=${streamToken}`);

  return {
    url,
    isHls: proxyType === 'hls',
    // proxyReady=false → server is still building the proxy (H.264 or HLS);
    // raw VP9/WebM is unplayable on iOS so we show a spinner and keep polling.
    proxyReady: proxyReady !== false,
    // proxySkipped=true → proxy build permanently skipped (genuine error
    // fallback; should not normally occur with the HLS path in place).
    proxySkipped: proxySkipped === true,
  };
}

type CachedStream = {
  url: string;
  isHls: boolean;
  expiresAt: number;
};

// Keep the exact same signed URL while the app stays open. Expo Video's native
// cache is keyed by source URL, so minting a new signed URL on every tab visit
// made already-buffered bytes look like a completely different video.
const streamUrlCache = new Map<string, CachedStream>();
const STREAM_URL_REUSE_MS = 4.5 * 60 * 60_000;

function streamCacheKey(gameId: number, type: 'video' | 'highlight' | 'lowlight') {
  return `${gameId}:${type}`;
}

async function getReelPlaybackUrl(
  gameId: number,
  type: 'highlight' | 'lowlight',
  objectPath: string,
  remoteUrl: string,
  forceFresh = false,
) {
  if (Platform.OS === 'web') return remoteUrl;
  if (forceFresh) await reelDownloadManager.invalidate(gameId, type, objectPath);
  const existing = reelDownloadManager.get(gameId, type, objectPath);
  if (existing?.status === 'downloaded' && existing.uri) return existing.uri;
  // iOS reel playback is local-only. The production proxy can abort progressive
  // playback after a few seconds, and an expired signed URL leaves AVPlayer black.
  // Keep the native surface mounted, but do not attach media until the background
  // manager has produced a complete local file.
  await reelDownloadManager.enqueue({ gameId, type, objectPath, url: remoteUrl }, true);
  return null;
}

async function getReusableStreamUrl(
  gameId: number,
  type: 'video' | 'highlight' | 'lowlight',
  token: string,
) {
  const key = streamCacheKey(gameId, type);
  const cached = streamUrlCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      url: cached.url,
      isHls: cached.isHls,
      proxyReady: true,
      proxySkipped: false,
    };
  }

  const result = await fetchStreamUrl(gameId, type, token);
  if (result.proxyReady) {
    streamUrlCache.set(key, {
      url: result.url,
      isHls: result.isHls,
      expiresAt: Date.now() + STREAM_URL_REUSE_MS,
    });
  }
  return result;
}

function playbackSource(url: string, isHls: boolean, allowCaching = true) {
  if (url.startsWith('file:')) {
    return {
      uri: url,
      useCaching: false,
      contentType: 'progressive' as const,
    };
  }
  return {
    uri: url,
    // iOS cannot cache HLS through Expo Video, but progressive MP4 footage,
    // highlights, and lowlights are cached on both iOS and Android.
    useCaching: allowCaching && (!isHls || Platform.OS === 'android'),
    contentType: isHls ? 'hls' as const : 'progressive' as const,
  };
}

function configureReviewPlayer(player: ReturnType<typeof useVideoPlayer>) {
  player.bufferOptions = {
    preferredForwardBufferDuration: 60,
    waitsToMinimizeStalling: true,
    minBufferForPlayback: 2,
    maxBufferBytes: 256 * 1024 * 1024,
    prioritizeTimeOverSizeThreshold: true,
  };
}

type Tab = 'stats' | 'video' | 'highlights' | 'lowlights';

type ReviewEvent = {
  playerId: number;
  statField: string;
  delta: number;
  videoTimestampMs: number | null;
};

const REVIEW_STAT_LABELS: Record<string, string> = {
  ftMade: 'FT Made',
  ftAttempted: 'FT Miss',
  twoMade: '2PT Made',
  twoAttempted: '2PT Miss',
  threeMade: '3PT Made',
  threeAttempted: '3PT Miss',
  assists: 'Assist',
  rebounds: 'Rebound',
  steals: 'Steal',
  turnovers: 'Turnover',
  blocks: 'Block',
};

const REVIEW_CATEGORIES = [
  { key: 'all', label: 'All', color: '#9ca3af', fields: [] as string[] },
  { key: 'made', label: 'Made', color: '#22c55e', fields: ['twoMade', 'threeMade', 'ftMade'] },
  { key: 'missed', label: 'Missed', color: '#ef4444', fields: ['twoAttempted', 'threeAttempted', 'ftAttempted'] },
  { key: 'assist', label: 'Assists', color: '#3b82f6', fields: ['assists'] },
  { key: 'rebound', label: 'Rebounds', color: '#06b6d4', fields: ['rebounds'] },
  { key: 'steal', label: 'Steals', color: '#a855f7', fields: ['steals'] },
  { key: 'block', label: 'Blocks', color: '#6366f1', fields: ['blocks'] },
  { key: 'turnover', label: 'TOs', color: '#f97316', fields: ['turnovers'] },
] as const;

function formatReviewTime(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function reviewEventColor(statField: string) {
  return REVIEW_CATEGORIES.find((category) => category.fields.includes(statField as never))?.color ?? '#9ca3af';
}

function FilmRoomSection({
  game,
  player,
  colors,
}: {
  game: any;
  player: ReturnType<typeof useVideoPlayer>;
  colors: any;
}) {
  const [currentTime, setCurrentTime] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(0);
  const [activePlayerId, setActivePlayerId] = useState<number | null>(null);
  const [activeCategory, setActiveCategory] = useState('all');
  const [timelineWidth, setTimelineWidth] = useState(0);

  useEffect(() => {
    player.timeUpdateEventInterval = 0.5;
    const timeSubscription = player.addListener('timeUpdate', ({ currentTime: nextTime }) => {
      setCurrentTime(nextTime);
      const duration = player.duration;
      if (Number.isFinite(duration) && duration > 0) setMediaDuration(duration);
    });
    const sourceSubscription = player.addListener('sourceLoad', () => {
      const duration = player.duration;
      if (Number.isFinite(duration) && duration > 0) setMediaDuration(duration);
    });
    return () => {
      timeSubscription.remove();
      sourceSubscription.remove();
    };
  }, [player]);

  const toVideoSeconds = useCallback((timestampMs: number) => {
    const gapAdjustment =
      game.videoHalf2StartMs != null &&
      game.videoHalftimeGapMs != null &&
      timestampMs >= game.videoHalf2StartMs
        ? game.videoHalftimeGapMs
        : 0;
    return (timestampMs - (game.videoOffsetMs ?? 0) - gapAdjustment) / 1000;
  }, [game.videoHalf2StartMs, game.videoHalftimeGapMs, game.videoOffsetMs]);

  const events = ((game.events ?? []) as ReviewEvent[])
    .filter((event) => event.videoTimestampMs != null && toVideoSeconds(event.videoTimestampMs) >= 0)
    .map((event, originalIndex) => ({ ...event, originalIndex }))
    .sort((a, b) => (a.videoTimestampMs! - b.videoTimestampMs!));

  const players: { id: number; name: string }[] = (game.stats ?? []).reduce((result: { id: number; name: string }[], stat: any) => {
    if (!result.some((item) => item.id === stat.playerId)) {
      result.push({ id: stat.playerId, name: stat.playerName ?? `Player ${stat.playerId}` });
    }
    return result;
  }, []);
  events.forEach((event) => {
    if (!players.some((item) => item.id === event.playerId)) {
      players.push({ id: event.playerId, name: `Player ${event.playerId}` });
    }
  });

  const filmDuration = game.videoDurationMs != null && game.videoDurationMs > 0
    ? game.videoDurationMs / 1000
    : mediaDuration;
  const isOffFilm = useCallback((event: ReviewEvent) => {
    if (!filmDuration || event.videoTimestampMs == null) return false;
    return toVideoSeconds(event.videoTimestampMs) >= filmDuration;
  }, [filmDuration, toVideoSeconds]);

  const playerFilteredEvents = activePlayerId == null
    ? events
    : events.filter((event) => event.playerId === activePlayerId);
  const filteredEvents = activeCategory === 'all'
    ? playerFilteredEvents
    : playerFilteredEvents.filter((event) => {
      const category = REVIEW_CATEGORIES.find((item) => item.key === activeCategory);
      return category?.fields.includes(event.statField as never);
    });
  const offFilmCount = events.filter(isOffFilm).length;
  const currentEventIndex = filteredEvents.findLastIndex(
    (event) => !isOffFilm(event) && toVideoSeconds(event.videoTimestampMs!) <= currentTime + 8,
  );

  if (events.length === 0) return null;

  const seekToEvent = (event: ReviewEvent) => {
    if (event.videoTimestampMs == null || isOffFilm(event)) return;
    player.currentTime = Math.max(0, toVideoSeconds(event.videoTimestampMs) - 8);
    player.play();
  };

  const seekOnTimeline = (locationX: number) => {
    if (!timelineWidth || !filmDuration) return;
    player.currentTime = Math.max(0, Math.min(filmDuration, (locationX / timelineWidth) * filmDuration));
  };

  return (
    <View style={[filmStyle.container, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={[filmStyle.header, { borderBottomColor: colors.border }]}>
        <Ionicons name="play-circle-outline" size={18} color={colors.primary} />
        <Text style={[filmStyle.headerTitle, { color: colors.foreground }]}>Film Room</Text>
        <Text style={[filmStyle.headerCount, { color: colors.mutedForeground }]}>
          {offFilmCount > 0 ? `${events.length - offFilmCount} of ${events.length} on film` : `${events.length} events`}
        </Text>
      </View>

      {offFilmCount > 0 && (
        <Text style={[filmStyle.notice, { color: '#fbbf24', backgroundColor: '#f59e0b18' }]}>
          {offFilmCount} {offFilmCount === 1 ? 'stat was' : 'stats were'} logged after the recording stopped and {offFilmCount === 1 ? "isn't" : "aren't"} on film.
        </Text>
      )}

      <View style={[filmStyle.timelineSection, { borderBottomColor: colors.border }]}>
        <View style={filmStyle.timelineLabels}>
          <Text style={[filmStyle.timeText, { color: colors.mutedForeground }]}>{formatReviewTime(currentTime)}</Text>
          <Text style={[filmStyle.timeText, { color: colors.mutedForeground }]}>{formatReviewTime(filmDuration)}</Text>
        </View>
        <Pressable
          testID="film-room-timeline"
          onLayout={(event) => setTimelineWidth(event.nativeEvent.layout.width)}
          onPress={(event) => seekOnTimeline(event.nativeEvent.locationX)}
          style={[filmStyle.timeline, { backgroundColor: colors.muted }]}
        >
          <View style={[filmStyle.timelineFill, { width: `${filmDuration ? Math.min(100, (currentTime / filmDuration) * 100) : 0}%`, backgroundColor: colors.primary }]} />
          {events.map((event) => {
            const seconds = toVideoSeconds(event.videoTimestampMs!);
            const percent = filmDuration ? (seconds / filmDuration) * 100 : -1;
            if (percent < 0 || percent > 100) return null;
            return (
              <Pressable
                key={event.originalIndex}
                onPress={(pressEvent) => {
                  pressEvent.stopPropagation();
                  seekToEvent(event);
                }}
                hitSlop={6}
                style={[filmStyle.marker, { left: `${percent}%`, backgroundColor: isOffFilm(event) ? colors.mutedForeground : reviewEventColor(event.statField) }]}
              />
            );
          })}
          <View style={[filmStyle.playhead, { left: `${filmDuration ? Math.min(100, (currentTime / filmDuration) * 100) : 0}%`, backgroundColor: colors.foreground }]} />
        </Pressable>
        <Text style={[filmStyle.timelineHint, { color: colors.mutedForeground }]}>Tap the timeline or an event to jump to that moment</Text>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={filmStyle.chipRow}>
        <TouchableOpacity
          testID="film-room-player-all"
          onPress={() => setActivePlayerId(null)}
          style={[filmStyle.chip, { borderColor: activePlayerId == null ? colors.primary : colors.border, backgroundColor: activePlayerId == null ? colors.primary + '20' : colors.background }]}
        >
          <Text style={[filmStyle.chipText, { color: activePlayerId == null ? colors.primary : colors.mutedForeground }]}>All players</Text>
        </TouchableOpacity>
        {players.map((item) => (
          <TouchableOpacity
            key={item.id}
            testID={`film-room-player-${item.id}`}
            onPress={() => setActivePlayerId(item.id)}
            style={[filmStyle.chip, { borderColor: activePlayerId === item.id ? colors.primary : colors.border, backgroundColor: activePlayerId === item.id ? colors.primary + '20' : colors.background }]}
          >
            <Text style={[filmStyle.chipText, { color: activePlayerId === item.id ? colors.primary : colors.mutedForeground }]} numberOfLines={1}>{item.name}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={filmStyle.chipRow}>
        {REVIEW_CATEGORIES.map((category) => {
          const count = category.key === 'all'
            ? playerFilteredEvents.length
            : playerFilteredEvents.filter((event) => category.fields.includes(event.statField as never)).length;
          if (count === 0 && category.key !== 'all') return null;
          const selected = activeCategory === category.key;
          return (
            <TouchableOpacity
              key={category.key}
              testID={`film-room-category-${category.key}`}
              onPress={() => setActiveCategory(category.key)}
              style={[filmStyle.chip, { borderColor: selected ? category.color : colors.border, backgroundColor: selected ? `${category.color}20` : colors.background }]}
            >
              <Text style={[filmStyle.chipText, { color: selected ? category.color : colors.mutedForeground }]}>
                {category.label} {count}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {filteredEvents.length === 0 ? (
        <Text style={[filmStyle.empty, { color: colors.mutedForeground }]}>No events for these filters.</Text>
      ) : (
        filteredEvents.map((event, index) => {
          const eventPlayer = players.find((item) => item.id === event.playerId);
          const offFilm = isOffFilm(event);
          const active = !offFilm && index === currentEventIndex;
          return (
            <TouchableOpacity
              key={`${event.originalIndex}-${index}`}
              testID={`film-room-event-${event.originalIndex}`}
              onPress={() => seekToEvent(event)}
              disabled={offFilm}
              activeOpacity={0.7}
              style={[filmStyle.eventRow, { borderTopColor: colors.border, backgroundColor: active ? colors.primary + '14' : 'transparent', opacity: offFilm ? 0.45 : 1 }]}
            >
              <View style={[filmStyle.eventPip, { backgroundColor: offFilm ? colors.mutedForeground : reviewEventColor(event.statField) }]} />
              <Text style={[filmStyle.eventTime, { color: colors.mutedForeground }]}>{formatReviewTime(toVideoSeconds(event.videoTimestampMs!))}</Text>
              <Text style={[filmStyle.eventLabel, { color: active ? colors.foreground : colors.mutedForeground }]} numberOfLines={1}>
                <Text style={{ fontFamily: 'Inter_600SemiBold' }}>{eventPlayer?.name ?? 'Player'}</Text>
                {' — '}{REVIEW_STAT_LABELS[event.statField] ?? event.statField}
              </Text>
              <Ionicons name={offFilm ? 'eye-off-outline' : 'play-outline'} size={15} color={offFilm ? colors.mutedForeground : active ? colors.primary : colors.mutedForeground} />
            </TouchableOpacity>
          );
        })
      )}
    </View>
  );
}

const filmStyle = StyleSheet.create({
  container: {
    marginHorizontal: 16,
    marginTop: 16,
    borderWidth: 1,
    borderRadius: 14,
    overflow: 'hidden',
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1 },
  headerTitle: { fontSize: 15, fontFamily: 'Inter_700Bold' },
  headerCount: { marginLeft: 'auto', fontSize: 11, fontFamily: 'Inter_500Medium' },
  notice: { paddingHorizontal: 14, paddingVertical: 9, fontSize: 12, fontFamily: 'Inter_400Regular' },
  timelineSection: { paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1 },
  timelineLabels: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  timeText: { fontSize: 11, fontFamily: 'Inter_500Medium', fontVariant: ['tabular-nums'] },
  timeline: { height: 20, borderRadius: 5, overflow: 'hidden', position: 'relative' },
  timelineFill: { position: 'absolute', left: 0, top: 0, bottom: 0, opacity: 0.22 },
  marker: { position: 'absolute', top: 2, bottom: 2, width: 4, borderRadius: 2, transform: [{ translateX: -2 }] },
  playhead: { position: 'absolute', top: 0, bottom: 0, width: 2, transform: [{ translateX: -1 }] },
  timelineHint: { fontSize: 10, fontFamily: 'Inter_400Regular', marginTop: 7 },
  chipRow: { gap: 7, paddingHorizontal: 12, paddingVertical: 10 },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6, maxWidth: 170 },
  chipText: { fontSize: 12, fontFamily: 'Inter_600SemiBold' },
  empty: { textAlign: 'center', fontSize: 13, fontFamily: 'Inter_400Regular', paddingHorizontal: 14, paddingBottom: 16 },
  eventRow: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 14, paddingVertical: 9, borderTopWidth: 1 },
  eventPip: { width: 8, height: 8, borderRadius: 4 },
  eventTime: { width: 42, fontSize: 11, fontFamily: 'Inter_500Medium', fontVariant: ['tabular-nums'] },
  eventLabel: { flex: 1, fontSize: 13, fontFamily: 'Inter_400Regular' },
});

function PlayerStatCard({ stat, rank, colors }: { stat: any; rank: number; colors: any }) {
  const secondaryStats: [string, number][] = [
    ['REB', stat.rebounds ?? 0],
    ['AST', stat.assists ?? 0],
    ['STL', stat.steals ?? 0],
    ['BLK', stat.blocks ?? 0],
    ['TO',  stat.turnovers ?? 0],
  ];
  return (
    <View style={[cardStyle.wrap, { backgroundColor: colors.card, borderColor: colors.border }]}>
      {/* Name row + PTS hero */}
      <View style={cardStyle.top}>
        <View style={[cardStyle.rank, { backgroundColor: colors.muted }]}>
          <Text style={[cardStyle.rankText, { color: colors.mutedForeground }]}>{rank}</Text>
        </View>
        <Text style={[cardStyle.name, { color: colors.foreground }]} numberOfLines={1}>{stat.playerName}</Text>
        <View style={cardStyle.ptsBlock}>
          <Text style={[cardStyle.ptsNum, { color: colors.primary }]}>{stat.points ?? 0}</Text>
          <Text style={[cardStyle.ptsLabel, { color: colors.primary }]}>PTS</Text>
        </View>
      </View>
      {/* Secondary stats row */}
      <View style={[cardStyle.statsRow, { borderTopColor: colors.border }]}>
        {secondaryStats.map(([label, value], i) => (
          <View key={label} style={[cardStyle.statCell, i > 0 && { borderLeftColor: colors.border, borderLeftWidth: 1 }]}>
            <Text style={[cardStyle.statVal, { color: value > 0 ? colors.foreground : colors.mutedForeground }]}>
              {value}
            </Text>
            <Text style={[cardStyle.statLabel, { color: colors.mutedForeground }]}>{label}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function TeamTotalsRow({ stats, colors }: { stats: any[]; colors: any }) {
  const totals = stats.reduce(
    (acc, s) => ({
      points:    acc.points    + (s.points    ?? 0),
      rebounds:  acc.rebounds  + (s.rebounds  ?? 0),
      assists:   acc.assists   + (s.assists   ?? 0),
      steals:    acc.steals    + (s.steals    ?? 0),
      blocks:    acc.blocks    + (s.blocks    ?? 0),
      turnovers: acc.turnovers + (s.turnovers ?? 0),
    }),
    { points: 0, rebounds: 0, assists: 0, steals: 0, blocks: 0, turnovers: 0 }
  );
  const cells: [string, number][] = [
    ['PTS', totals.points], ['REB', totals.rebounds], ['AST', totals.assists],
    ['STL', totals.steals], ['BLK', totals.blocks],   ['TO',  totals.turnovers],
  ];
  return (
    <View style={[cardStyle.totalsWrap, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Text style={[cardStyle.totalsLabel, { color: colors.mutedForeground }]}>TEAM TOTALS</Text>
      <View style={cardStyle.totalsRow}>
        {cells.map(([label, value], i) => (
          <View key={label} style={[cardStyle.statCell, i > 0 && { borderLeftColor: colors.border, borderLeftWidth: 1 }]}>
            <Text style={[cardStyle.statVal, { color: colors.foreground }]}>{value}</Text>
            <Text style={[cardStyle.statLabel, { color: colors.mutedForeground }]}>{label}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const cardStyle = StyleSheet.create({
  wrap: {
    marginHorizontal: 16,
    marginTop: 10,
    borderRadius: 14,
    borderWidth: 1,
    overflow: 'hidden',
  },
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 10,
  },
  rank: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rankText: { fontSize: 11, fontFamily: 'Inter_700Bold' },
  name: { flex: 1, fontSize: 15, fontFamily: 'Inter_600SemiBold' },
  ptsBlock: { alignItems: 'center' },
  ptsNum: { ...tekoStyle(28, 'semiBold'), lineHeight: 30 },
  ptsLabel: { fontSize: 9, fontFamily: 'Inter_700Bold', letterSpacing: 0.8, marginTop: -2 },
  statsRow: {
    flexDirection: 'row',
    borderTopWidth: 1,
  },
  statCell: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 8,
  },
  statVal: { ...tekoStyle(18, 'semiBold'), lineHeight: 20 },
  statLabel: { fontSize: 9, fontFamily: 'Inter_500Medium', letterSpacing: 0.5, textTransform: 'uppercase' },
  totalsWrap: {
    marginHorizontal: 16,
    marginTop: 14,
    marginBottom: 4,
    borderRadius: 14,
    borderWidth: 1,
    overflow: 'hidden',
  },
  totalsLabel: {
    fontSize: 10,
    fontFamily: 'Inter_700Bold',
    letterSpacing: 1,
    textTransform: 'uppercase',
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 6,
  },
  totalsRow: { flexDirection: 'row' },
});

function VideoSection({ game, colors }: { game: any; colors: any }) {
  const { getToken } = useAuth();
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [streamIsHls, setStreamIsHls] = useState(false);
  const [loadError, setLoadError] = useState(false);
  // proxyReady=false means the server is still building the H.264 proxy;
  // the raw file (VP9/WebM) is not playable on iOS, so we show a processing
  // state and poll until the proxy is ready.
  const [proxyReady, setProxyReady] = useState<boolean | null>(null);
  // proxySkipped=true when the server will never build a proxy (game too long
  // to transcode on RAM-backed /tmp). Stop polling and show a static message.
  const [proxySkipped, setProxySkipped] = useState(false);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const optimizingStartedAtRef = useRef<number | null>(null);
  const replaceGenerationRef = useRef(0);
  const replaceChainRef = useRef<Promise<void>>(Promise.resolve());

  const player = useVideoPlayer('', configureReviewPlayer);

  const loadStream = useCallback(
    (cancelled: { value: boolean }) => {
      if (!game.videoObjectPath) return;
      getToken()
        .then((token) => {
          if (!token || cancelled.value) return;
          return getReusableStreamUrl(game.id, 'video', token);
        })
        .then((result) => {
          if (!result || cancelled.value) return;
          if (result.proxySkipped) {
            // Proxy will never be built — stop polling immediately.
            setProxySkipped(true);
            setProxyReady(false);
            return;
          }
          setProxyReady(result.proxyReady);
          if (result.proxyReady) {
            optimizingStartedAtRef.current = null;
            setStreamIsHls(result.isHls);
            setStreamUrl(result.url);
          } else {
            if (optimizingStartedAtRef.current == null) optimizingStartedAtRef.current = Date.now();
            // Encoding a long recording can take several minutes. Avoid flooding
            // the readiness endpoint while the server owns one background build.
            retryTimerRef.current = setTimeout(() => {
              if (!cancelled.value) loadStream(cancelled);
            }, 15_000);
          }
        })
        .catch(() => { if (!cancelled.value) setLoadError(true); });
    },
    [game.id, game.videoObjectPath],
  );

  useEffect(() => {
    if (!game.videoObjectPath) return;
    const cancelled = { value: false };
    loadStream(cancelled);
    return () => {
      cancelled.value = true;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, [game.videoObjectPath, loadStream]);

  // Do not attach the source until streamUrl has caused the VideoView below to
  // mount. Attaching while this component still renders its loading spinner
  // leaves AVPlayer with a valid source but no native surface (black crossed-
  // play screen on iOS).
  useEffect(() => {
    if (!streamUrl) return;
    const generation = ++replaceGenerationRef.current;
    let cancelled = false;
    replaceChainRef.current = replaceChainRef.current
      .catch(() => {})
      .then(async () => {
        if (cancelled || generation !== replaceGenerationRef.current) return;
        await player.replaceAsync(playbackSource(streamUrl, streamIsHls));
      })
      .catch(() => {
        if (!cancelled && generation === replaceGenerationRef.current) setLoadError(true);
      });
    return () => {
      cancelled = true;
      replaceGenerationRef.current++;
    };
  }, [player, streamUrl, streamIsHls]);

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

  // Game too long to transcode — proxy will never be built.
  if (proxySkipped) {
    return (
      <View style={videoStyle.empty}>
        <Ionicons name="time-outline" size={40} color={colors.mutedForeground} style={{ marginBottom: 12 }} />
        <Text style={[videoStyle.emptyText, { color: colors.foreground }]}>
          Video too long to optimize
        </Text>
        <Text style={[videoStyle.emptySubText, { color: colors.mutedForeground }]}>
          Full-game recordings over 15 minutes can't be processed on this device. Open the game in a browser to watch the video.
        </Text>
      </View>
    );
  }

  // Proxy is still being built — raw WebM is unplayable on iOS.
  if (proxyReady === false) {
    return (
      <View style={videoStyle.empty}>
        <ActivityIndicator color={colors.primary} style={{ marginBottom: 12 }} />
        <Text style={[videoStyle.emptyText, { color: colors.foreground }]}>
          Optimizing video for playback…
        </Text>
        <Text style={[videoStyle.emptySubText, { color: colors.mutedForeground }]}>
          Long recordings can take several minutes. You can leave this screen—the page will update automatically when playable footage is ready.
        </Text>
      </View>
    );
  }

  if (!streamUrl) {
    return <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />;
  }

  return (
    <>
      <ZoomableVideo style={videoStyle.wrap}>
        <VideoView
          player={player}
          style={videoStyle.video}
          contentFit="contain"
          allowsFullscreen
          allowsPictureInPicture
          nativeControls
        />
      </ZoomableVideo>
      <FilmRoomSection game={game} player={player} colors={colors} />
      <TouchableOpacity
        testID="save-full-game"
        onPress={() => saveReviewVideo(streamUrl, `Full Game — vs ${game.opponent}`)}
        activeOpacity={0.8}
        style={[reviewAction.rowButton, { backgroundColor: colors.card, borderColor: colors.border }]}
      >
        <Feather name="download" size={16} color={colors.primary} />
        <Text style={[reviewAction.rowButtonText, { color: colors.primary }]}>Save Video</Text>
      </TouchableOpacity>
    </>
  );
}

const videoStyle = StyleSheet.create({
  wrap: { marginHorizontal: 16, marginTop: 16, borderRadius: 12, overflow: 'hidden' },
  video: { width: '100%', aspectRatio: 16 / 9, backgroundColor: '#000' },
  empty: { alignItems: 'center', paddingTop: 60, paddingHorizontal: 32, gap: 8 },
  emptyText: { fontSize: 15, fontFamily: 'Inter_400Regular', textAlign: 'center' },
  emptySubText: { fontSize: 13, fontFamily: 'Inter_400Regular', textAlign: 'center', marginTop: 4, opacity: 0.75 },
  playbackLoading: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 10,
  },
  waitingTitle: { fontSize: 16, fontFamily: 'Inter_600SemiBold', textAlign: 'center' },
  waitingText: { fontSize: 13, fontFamily: 'Inter_400Regular', textAlign: 'center', lineHeight: 19, maxWidth: 300 },
  playbackError: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 12,
  },
  playbackErrorText: {
    fontSize: 15,
    fontFamily: 'Inter_500Medium',
    textAlign: 'center',
  },
  downloadedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 7,
  },
  downloadedText: {
    fontSize: 12,
    fontFamily: 'Inter_600SemiBold',
  },
  retryButton: {
    minHeight: 42,
    borderRadius: 10,
    paddingHorizontal: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  retryButtonText: {
    color: '#fff',
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
  },
});

// Module-level maps so processing start times survive tab-switches/remounts.
// Separate maps for highlight vs lowlight so they don't interfere.
const processingStartTimes    = new Map<number, number>();
const lowlightStartTimes      = new Map<number, number>();

function LowlightSection({ gameId, colors }: { gameId: number; colors: any }) {
  const { getToken } = useAuth();
  const { downloads, cellularAllowed, setCellularAllowed } = useReelDownloads();
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;
  const { data: lowlight, refetch } = useGetGameLowlight(gameId);
  const generateMutation = useGenerateGameLowlight();
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [playbackLoading, setPlaybackLoading] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [sourceAttachRequest, setSourceAttachRequest] = useState<{ url: string; id: number } | null>(null);
  const automaticRetryRef = useRef(false);
  const loadGenerationRef = useRef(0);
  const sourceAttachGenerationRef = useRef(0);
  const sourceAttachChainRef = useRef<Promise<void>>(Promise.resolve());
  const attachedSourceRef = useRef<string | null>(null);

  const player = useVideoPlayer('', configureReviewPlayer);

  // Poll every 3 s while generating
  useEffect(() => {
    if (lowlight?.status !== 'processing') return;
    const timer = setInterval(() => refetch(), 3000);
    return () => clearInterval(timer);
  }, [lowlight?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  // Elapsed-seconds counter, survives tab switches via module-level map
  useEffect(() => {
    if (lowlight?.status !== 'processing') {
      lowlightStartTimes.delete(gameId);
      setElapsedSec(0);
      return;
    }
    if (!lowlightStartTimes.has(gameId)) {
      lowlightStartTimes.set(gameId, Date.now());
    }
    const getElapsed = () =>
      Math.floor((Date.now() - (lowlightStartTimes.get(gameId) ?? Date.now())) / 1000);
    setElapsedSec(getElapsed());
    const t = setInterval(() => setElapsedSec(getElapsed()), 1000);
    return () => clearInterval(t);
  }, [lowlight?.status, gameId]); // eslint-disable-line react-hooks/exhaustive-deps

  const lowlightReady = lowlight?.status === 'ready';
  const lowlightDownload = downloads.find((item) => item.gameId === gameId && item.type === 'lowlight' && item.objectPath === lowlight?.lowlightObjectPath);

  const loadLowlightVideo = useCallback(async (forceFresh = false) => {
    const loadGeneration = ++loadGenerationRef.current;
    const isCurrentLoad = () => loadGeneration === loadGenerationRef.current;
    setPlaybackLoading(true);
    setPlaybackError(null);
    try {
      const objectPath = lowlight?.lowlightObjectPath;
      if (!objectPath) throw new Error('The lowlight file is not available.');
      const token = await getTokenRef.current();
      if (!isCurrentLoad()) return;
      if (!token) throw new Error('Your session expired. Please sign in again.');
      if (forceFresh) {
        attachedSourceRef.current = null;
        streamUrlCache.delete(streamCacheKey(gameId, 'lowlight'));
        await reelDownloadManager.invalidate(gameId, 'lowlight', objectPath);
        if (!isCurrentLoad()) return;
      }
      const result = forceFresh
        ? await fetchStreamUrl(gameId, 'lowlight', token)
        : await getReusableStreamUrl(gameId, 'lowlight', token);
      if (!isCurrentLoad()) return;
      const playbackUrl = await getReelPlaybackUrl(gameId, 'lowlight', objectPath, result.url, forceFresh);
      if (!isCurrentLoad()) return;
      if (!playbackUrl) {
        setSignedUrl(null);
        setPlaybackLoading(false);
        return;
      }
      setSignedUrl(playbackUrl);
      setSourceAttachRequest({ url: playbackUrl, id: loadGeneration });
    } catch (error: any) {
      if (!isCurrentLoad()) return;
      setSignedUrl(null);
      setPlaybackError(error?.message ?? 'The lowlight video could not be loaded.');
      setPlaybackLoading(false);
    }
  }, [gameId, lowlight?.lowlightObjectPath, player]);

  useEffect(() => () => {
    loadGenerationRef.current++;
    sourceAttachGenerationRef.current++;
    attachedSourceRef.current = null;
  }, [lowlight?.lowlightObjectPath]);

  // Commit the local URI first so React has mounted the native VideoView before
  // AVPlayer receives the source. Serialize replacements so a stale async load
  // can never overwrite the latest requested reel.
  useEffect(() => {
    if (!sourceAttachRequest) return;
    const generation = sourceAttachRequest.id;
    sourceAttachGenerationRef.current = generation;
    let cancelled = false;
    sourceAttachChainRef.current = sourceAttachChainRef.current
      .catch(() => undefined)
      .then(async () => {
        if (cancelled || generation !== sourceAttachGenerationRef.current) return;
        if (attachedSourceRef.current === sourceAttachRequest.url) {
          setPlaybackLoading(false);
          return;
        }
        await player.replaceAsync(playbackSource(sourceAttachRequest.url, false));
        if (cancelled || generation !== sourceAttachGenerationRef.current) return;
        attachedSourceRef.current = sourceAttachRequest.url;
        setPlaybackLoading(false);
      })
      .catch((error: any) => {
        if (cancelled || generation !== sourceAttachGenerationRef.current) return;
        setPlaybackError(error?.message ?? 'The lowlight video could not be loaded.');
        setPlaybackLoading(false);
      });
    return () => { cancelled = true; };
  }, [player, sourceAttachRequest]);

  useEffect(() => {
    if (!lowlightReady) return;
    automaticRetryRef.current = false;
    void loadLowlightVideo();
  }, [lowlightReady, gameId, lowlightDownload?.status, lowlightDownload?.uri, loadLowlightVideo]);

  useEffect(() => {
    const subscription = player.addListener('statusChange', ({ status, error }) => {
      if (status !== 'error') return;
      setPlaybackError(error?.message ?? 'The lowlight video could not be loaded.');
      // Never delete a completed local file out from under AVPlayer. A prior
      // automatic retry did exactly that after a transient native status error,
      // causing playback to exit partway through and reducing the offline count.
      if (signedUrl?.startsWith('file:')) return;
      if (!automaticRetryRef.current) {
        automaticRetryRef.current = true;
        void loadLowlightVideo(true);
      }
    });
    return () => subscription.remove();
  }, [player, signedUrl, loadLowlightVideo]);

  async function handleSaveLowlight() {
    if (!signedUrl) return;
    await saveReviewVideo(signedUrl, 'Game Lowlights');
  }

  async function handleRegenerateLowlight() {
    if (generateMutation.isPending) return;
    try {
      attachedSourceRef.current = null;
      await reelDownloadManager.invalidate(gameId, 'lowlight', lowlight?.lowlightObjectPath);
      streamUrlCache.delete(streamCacheKey(gameId, 'lowlight'));
      setSignedUrl(null);
      await generateMutation.mutateAsync({ gameId });
      refetch();
    } catch {
      Alert.alert('Could Not Regenerate', 'Please try again in a moment.');
    }
  }

  async function handleCancelLowlight() {
    try {
      const token = await getToken();
      await fetch(`${API_BASE}/api/games/${gameId}/lowlight`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      refetch();
    } catch {
      Alert.alert('Could Not Cancel', 'The lowlight reel is still processing. Please try again.');
    }
  }

  if (!lowlight) return <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />;

  if (lowlight.status === 'ready') {
    return (
      <View style={{ flex: 1, backgroundColor: colors.card }}>
        <ZoomableVideo style={{ flex: 1, backgroundColor: colors.card }}>
          {playbackError && !playbackLoading ? (
            <View style={[videoStyle.playbackError, { backgroundColor: colors.background }]}>
              <Feather name="alert-circle" size={28} color={colors.mutedForeground} />
              <Text style={[videoStyle.playbackErrorText, { color: colors.foreground }]}>
                This lowlight could not be downloaded.
              </Text>
              <TouchableOpacity
                testID="retry-lowlight-playback"
                onPress={() => {
                  automaticRetryRef.current = false;
                  void loadLowlightVideo(true);
                }}
                style={[videoStyle.retryButton, { backgroundColor: colors.primary }]}
              >
                <Feather name="refresh-cw" size={15} color="#fff" />
                <Text style={videoStyle.retryButtonText}>Retry Video</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              <VideoView
                player={player}
                style={{ flex: 1 }}
                contentFit="cover"
                allowsFullscreen
                allowsPictureInPicture
                nativeControls
              />
              {(!signedUrl || playbackLoading) && (
                <View style={[videoStyle.playbackLoading, { backgroundColor: colors.background }]}>
                  {lowlightDownload?.status === 'downloading' || playbackLoading ? (
                    <>
                      <ActivityIndicator color={colors.primary} />
                      <Text style={[videoStyle.waitingTitle, { color: colors.foreground }]}>Downloading lowlights…</Text>
                      <Text style={[videoStyle.waitingText, { color: colors.mutedForeground }]}>The video will appear here when it is ready.</Text>
                    </>
                  ) : (
                    <>
                      <Feather name="wifi-off" size={28} color={colors.mutedForeground} />
                      <Text style={[videoStyle.waitingTitle, { color: colors.foreground }]}>Waiting to download</Text>
                      <Text style={[videoStyle.waitingText, { color: colors.mutedForeground }]}>
                        Connect to Wi‑Fi, or download now using cellular data.
                      </Text>
                      {!cellularAllowed && (
                        <TouchableOpacity
                          testID="download-lowlight-cellular"
                          onPress={async () => {
                            await setCellularAllowed(true);
                            automaticRetryRef.current = false;
                            void loadLowlightVideo(true);
                          }}
                          style={[videoStyle.retryButton, { backgroundColor: colors.primary }]}
                        >
                          <Feather name="download" size={15} color="#fff" />
                          <Text style={videoStyle.retryButtonText}>Download now</Text>
                        </TouchableOpacity>
                      )}
                    </>
                  )}
                </View>
              )}
            </>
          )}
        </ZoomableVideo>
        {Platform.OS !== 'web' && lowlightDownload && (
          <View style={videoStyle.downloadedBadge}>
            <Feather name={lowlightDownload.status === 'failed' ? 'alert-circle' : lowlightDownload.status === 'downloaded' ? 'check-circle' : 'download'} size={14} color={colors.primary} />
            <Text style={[videoStyle.downloadedText, { color: colors.primary }]}>
              {lowlightDownload.status === 'downloaded' ? 'Downloaded on this device' : lowlightDownload.status === 'failed' ? 'Download failed — tap Retry Video' : `${lowlightDownload.status === 'downloading' ? 'Downloading' : 'Queued'} for offline playback`}
            </Text>
          </View>
        )}
        <View style={[ytStyle.bar, { borderTopColor: colors.border, backgroundColor: colors.card }]}>
          <TouchableOpacity
            testID="save-lowlight-video"
            onPress={handleSaveLowlight}
            style={[ytStyle.btn, { backgroundColor: colors.background, borderColor: colors.border, borderWidth: 1, flex: 1 }]}
            activeOpacity={0.8}
          >
            <Feather name="download" size={16} color={colors.foreground} />
            <Text style={[ytStyle.btnText, { color: colors.foreground }]}>Save Video</Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID="regenerate-lowlights"
            onPress={handleRegenerateLowlight}
            disabled={generateMutation.isPending}
            style={[ytStyle.btn, { backgroundColor: colors.background, borderColor: colors.border, borderWidth: 1, flex: 1, opacity: generateMutation.isPending ? 0.55 : 1 }]}
            activeOpacity={0.8}
          >
            {generateMutation.isPending ? (
              <ActivityIndicator size="small" color={colors.foreground} />
            ) : (
              <Ionicons name="refresh-outline" size={16} color={colors.foreground} />
            )}
            <Text style={[ytStyle.btnText, { color: colors.foreground }]}>{generateMutation.isPending ? 'Starting…' : 'Regenerate'}</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  if (lowlight.status === 'processing') {
    const pct = Math.min(97, Math.round(100 * (1 - Math.exp(-elapsedSec / 2000))));
    const label =
      elapsedSec < 60   ? 'Finding missed shots & turnovers…'
      : elapsedSec < 900  ? 'Downloading game footage…'
      : elapsedSec < 4500 ? 'Compressing clips…'
      : 'Finalizing…';
    const mins = Math.floor(elapsedSec / 60);
    const secs = elapsedSec % 60;
    const elapsed = mins > 0
      ? `${mins}m ${String(secs).padStart(2, '0')}s`
      : `${secs}s`;
    return (
      <View style={[videoStyle.empty, { gap: 12, paddingHorizontal: 24 }]}>
        <ActivityIndicator color={colors.destructive ?? '#ef4444'} size="large" />
        <Text style={[videoStyle.emptyText, { color: colors.foreground, fontFamily: 'Inter_600SemiBold' }]}>
          {label}
        </Text>
        <View style={{ width: '100%', height: 6, backgroundColor: colors.muted, borderRadius: 3, overflow: 'hidden' }}>
          <View style={{ width: `${pct}%`, height: '100%', backgroundColor: colors.destructive ?? '#ef4444', borderRadius: 3 }} />
        </View>
        <Text style={[videoStyle.emptyText, { color: colors.mutedForeground, fontSize: 12 }]}>
          {pct}% · {elapsed} elapsed — typically 30–90 min for a full game
        </Text>
        <TouchableOpacity
          testID="cancel-lowlights"
          onPress={handleCancelLowlight}
          activeOpacity={0.7}
          style={[reviewAction.cancelButton, { borderColor: colors.border }]}
        >
          <Text style={[reviewAction.cancelText, { color: colors.mutedForeground }]}>Cancel</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={videoStyle.empty}>
      <Ionicons name="trending-down-outline" size={40} color={colors.mutedForeground} />
      <Text style={[videoStyle.emptyText, { color: colors.mutedForeground }]}>
        {lowlight.eligibleMoments > 0
          ? `${lowlight.eligibleMoments} missed shots & turnovers to review`
          : 'No misses or turnovers recorded'}
      </Text>
      {lowlight.eligibleMoments > 0 && (
        <TouchableOpacity
          onPress={async () => {
            await generateMutation.mutateAsync({ gameId });
            refetch();
          }}
          style={{
            backgroundColor: colors.destructive ?? '#ef4444',
            borderRadius: 10,
            paddingHorizontal: 20,
            paddingVertical: 12,
            marginTop: 8,
          }}
          activeOpacity={0.8}
          disabled={generateMutation.isPending}
        >
          <Text style={{ color: '#fff', fontFamily: 'Inter_600SemiBold', fontSize: 15 }}>
            {generateMutation.isPending ? 'Starting…' : 'Generate Lowlights'}
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

type PrivacyStatus = 'public' | 'unlisted' | 'private';
function HighlightSection({ gameId, colors }: { gameId: number; colors: any }) {
  const { getToken } = useAuth();
  const { downloads, cellularAllowed, setCellularAllowed } = useReelDownloads();
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;
  const router = useRouter();
  const { data: highlight, refetch } = useGetGameHighlight(gameId);
  const generateMutation = useGenerateGameHighlight();
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);

  // YouTube upload state — seed from the highlight response so the link
  // persists across remounts (the URL is persisted in the DB on the server).
  const [uploadModalVisible, setUploadModalVisible] = useState(false);
  const [uploadTitle, setUploadTitle] = useState('');
  const [uploadPrivacy, setUploadPrivacy] = useState<PrivacyStatus>('unlisted');
  const [uploading, setUploading] = useState(false);
  const [youtubeUrl, setYoutubeUrl] = useState<string | null>(null);
  const [sharingClip, setSharingClip] = useState(false);
  const [playbackLoading, setPlaybackLoading] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [sourceAttachRequest, setSourceAttachRequest] = useState<{ url: string; id: number } | null>(null);
  const automaticRetryRef = useRef(false);
  const loadGenerationRef = useRef(0);
  const sourceAttachGenerationRef = useRef(0);
  const sourceAttachChainRef = useRef<Promise<void>>(Promise.resolve());
  const attachedSourceRef = useRef<string | null>(null);

  const player = useVideoPlayer('', configureReviewPlayer);

  // Sync stored YouTube URL from the server whenever the highlight data loads.
  useEffect(() => {
    if (highlight?.youtubeUrl && !youtubeUrl) {
      setYoutubeUrl(highlight.youtubeUrl);
    }
  }, [highlight?.youtubeUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll every 3 s while the server is generating the reel
  useEffect(() => {
    if (highlight?.status !== 'processing') return;
    const timer = setInterval(() => refetch(), 3000);
    return () => clearInterval(timer);
  }, [highlight?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  // Drive the elapsed-seconds counter while processing.
  // Use the module-level map so navigating away and back doesn't reset the clock.
  useEffect(() => {
    if (highlight?.status !== 'processing') {
      processingStartTimes.delete(gameId);
      setElapsedSec(0);
      return;
    }
    if (!processingStartTimes.has(gameId)) {
      processingStartTimes.set(gameId, Date.now());
    }
    const getElapsed = () => Math.floor((Date.now() - (processingStartTimes.get(gameId) ?? Date.now())) / 1000);
    setElapsedSec(getElapsed());
    const t = setInterval(() => setElapsedSec(getElapsed()), 1000);
    return () => clearInterval(t);
  }, [highlight?.status, gameId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Use the stream-token approach (from the seek-fix task) so the video can
  // be seeked without freezing — signed object-storage URLs don't support
  // Range requests reliably in production.
  const highlightReady = highlight?.status === 'ready';
  const highlightDownload = downloads.find((item) => item.gameId === gameId && item.type === 'highlight' && item.objectPath === highlight?.highlightObjectPath);

  const loadHighlightVideo = useCallback(async (
    forceFresh = false,
    disableCaching = false,
  ) => {
    const loadGeneration = ++loadGenerationRef.current;
    const isCurrentLoad = () => loadGeneration === loadGenerationRef.current;
    setPlaybackLoading(true);
    setPlaybackError(null);
    try {
      const objectPath = highlight?.highlightObjectPath;
      if (!objectPath) throw new Error('The highlight file is not available.');
      const token = await getTokenRef.current();
      if (!isCurrentLoad()) return;
      if (!token) throw new Error('Your session expired. Please sign in again.');

      if (forceFresh) {
        attachedSourceRef.current = null;
        streamUrlCache.delete(streamCacheKey(gameId, 'highlight'));
        await reelDownloadManager.invalidate(gameId, 'highlight', objectPath);
        if (!isCurrentLoad()) return;
      }
      const result = forceFresh
        ? await fetchStreamUrl(gameId, 'highlight', token)
        : await getReusableStreamUrl(gameId, 'highlight', token);
      if (!isCurrentLoad()) return;

      const playbackUrl = await getReelPlaybackUrl(
        gameId,
        'highlight',
        objectPath,
        result.url,
        forceFresh,
      );
      if (!isCurrentLoad()) return;
      if (!playbackUrl) {
        setSignedUrl(null);
        setPlaybackLoading(false);
        return;
      }
      if (result.proxyReady) {
        streamUrlCache.set(streamCacheKey(gameId, 'highlight'), {
          url: result.url,
          isHls: result.isHls,
          expiresAt: Date.now() + STREAM_URL_REUSE_MS,
        });
      }
      setSignedUrl(playbackUrl);
      setSourceAttachRequest({ url: playbackUrl, id: loadGeneration });
    } catch (error: any) {
      if (!isCurrentLoad()) return;
      setSignedUrl(null);
      setPlaybackError(error?.message ?? 'The highlight video could not be loaded.');
      setPlaybackLoading(false);
    }
  }, [gameId, highlight?.highlightObjectPath, player]);

  useEffect(() => () => {
    loadGenerationRef.current++;
    sourceAttachGenerationRef.current++;
    attachedSourceRef.current = null;
  }, [highlight?.highlightObjectPath]);

  // Attach only after the local URI state has committed and the native surface
  // exists. The serialized generation guard ensures the newest local source wins
  // if download discovery, tab navigation, and a manual retry overlap.
  useEffect(() => {
    if (!sourceAttachRequest) return;
    const generation = sourceAttachRequest.id;
    sourceAttachGenerationRef.current = generation;
    let cancelled = false;
    sourceAttachChainRef.current = sourceAttachChainRef.current
      .catch(() => undefined)
      .then(async () => {
        if (cancelled || generation !== sourceAttachGenerationRef.current) return;
        if (attachedSourceRef.current === sourceAttachRequest.url) {
          setPlaybackLoading(false);
          return;
        }
        await player.replaceAsync(playbackSource(sourceAttachRequest.url, false));
        if (cancelled || generation !== sourceAttachGenerationRef.current) return;
        attachedSourceRef.current = sourceAttachRequest.url;
        setPlaybackLoading(false);
      })
      .catch((error: any) => {
        if (cancelled || generation !== sourceAttachGenerationRef.current) return;
        setPlaybackError(error?.message ?? 'The highlight video could not be loaded.');
        setPlaybackLoading(false);
      });
    return () => { cancelled = true; };
  }, [player, sourceAttachRequest]);

  useEffect(() => {
    if (!highlightReady) return;
    let cancelled = false;
    automaticRetryRef.current = false;
    void loadHighlightVideo().then(() => {
      if (cancelled) return;
    });
    return () => { cancelled = true; };
  }, [highlightReady, gameId, highlightDownload?.status, highlightDownload?.uri, loadHighlightVideo]);

  // AVPlayer can reject a signed source after Expo Video has accepted it, so
  // replaceAsync resolving is not sufficient proof that playback is available.
  // Retry once with a fresh URL and native caching disabled; this bypasses a
  // stale/corrupt cache entry while preserving caching for the normal path.
  useEffect(() => {
    const subscription = player.addListener('statusChange', ({ status, error }) => {
      if (status !== 'error') return;
      const message = error?.message ?? 'The highlight video could not be loaded.';
      setPlaybackError(message);
      // The local MP4 is the durable source of truth. Do not invalidate/delete
      // it while AVPlayer still has the file open after a transient native error.
      if (signedUrl?.startsWith('file:')) return;
      if (!automaticRetryRef.current) {
        automaticRetryRef.current = true;
        void loadHighlightVideo(true, Platform.OS === 'ios');
      }
    });
    return () => subscription.remove();
  }, [player, signedUrl, loadHighlightVideo]);

  async function handleYoutubeUpload() {
    if (!uploadTitle.trim() || uploading) return;
    setUploading(true);
    try {
      const token = await getToken();
      const res = await fetch(`${API_BASE}/api/games/${gameId}/highlight/upload-youtube`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ title: uploadTitle.trim(), privacyStatus: uploadPrivacy }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.error === 'YOUTUBE_NOT_CONNECTED') {
          setUploadModalVisible(false);
          Alert.alert(
            'YouTube Not Connected',
            'Connect your YouTube account in the Profile tab first.',
            [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Go to Profile', onPress: () => router.push('/(tabs)/profile') },
            ],
          );
        } else if (data.error === 'UPGRADE_REQUIRED') {
          setUploadModalVisible(false);
          Alert.alert(
            'Pro Required',
            data.message ?? 'YouTube upload requires a Pro subscription.',
            [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Upgrade', onPress: () => router.push('/paywall') },
            ],
          );
        } else {
          Alert.alert('Upload Failed', data.error ?? 'Something went wrong. Please try again.');
        }
        return;
      }
      setYoutubeUrl(data.youtubeUrl ?? null);
      setUploadModalVisible(false);
    } catch {
      Alert.alert('Upload Failed', 'Something went wrong. Please try again.');
    } finally {
      setUploading(false);
    }
  }

  async function handleShareClip() {
    if (sharingClip) return;
    setSharingClip(true);
    try {
      const token = await getToken();
      if (!token) throw new Error('Not signed in');
      const res = await fetch(`${API_BASE}/api/games/${gameId}/share-token`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Could not generate share link');
      const { shareToken } = await res.json() as { shareToken: string };
      const url = `${WEB_BASE}/highlight/${shareToken}`;
      await Share.share({
        title: 'Game Highlights',
        message: `Watch our game highlights: ${url}`,
        url,
      });
    } catch (error: any) {
      if (error?.message !== 'User did not share') {
        Alert.alert('Share Failed', 'Could not create the highlight link. Please try again.');
      }
    } finally {
      setSharingClip(false);
    }
  }

  async function handleSaveClip() {
    if (!signedUrl) return;
    await saveReviewVideo(signedUrl, 'Game Highlights');
  }

  async function handleRegenerate() {
    if (generateMutation.isPending) return;
    try {
      attachedSourceRef.current = null;
      await reelDownloadManager.invalidate(gameId, 'highlight', highlight?.highlightObjectPath);
      streamUrlCache.delete(streamCacheKey(gameId, 'highlight'));
      setSignedUrl(null);
      await generateMutation.mutateAsync({ gameId });
      refetch();
    } catch {
      Alert.alert('Could Not Regenerate', 'Please try again in a moment.');
    }
  }

  async function handleCancelGeneration() {
    try {
      const token = await getToken();
      await fetch(`${API_BASE}/api/games/${gameId}/highlight`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      refetch();
    } catch {
      Alert.alert('Could Not Cancel', 'The highlight reel is still processing. Please try again.');
    }
  }

  if (!highlight) return <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />;

  if (highlight.status === 'ready') {
    return (
      <View style={{ flex: 1, backgroundColor: colors.card }}>
        {/* ZoomableVideo from the pinch-to-zoom task wraps only the player */}
        <ZoomableVideo style={{ flex: 1 }}>
          {playbackError && !playbackLoading ? (
            <View style={[videoStyle.playbackError, { backgroundColor: colors.background }]}>
              <Feather name="alert-circle" size={28} color={colors.mutedForeground} />
              <Text style={[videoStyle.playbackErrorText, { color: colors.foreground }]}>
                This highlight could not be loaded.
              </Text>
              <TouchableOpacity
                testID="retry-highlight-playback"
                onPress={() => {
                  automaticRetryRef.current = false;
                  void loadHighlightVideo(true, Platform.OS === 'ios');
                }}
                style={[videoStyle.retryButton, { backgroundColor: colors.primary }]}
              >
                <Feather name="refresh-cw" size={15} color="#fff" />
                <Text style={videoStyle.retryButtonText}>Retry Video</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              <VideoView
                player={player}
                style={{ flex: 1 }}
                contentFit="cover"
                allowsFullscreen
                allowsPictureInPicture
                nativeControls
              />
              {(!signedUrl || playbackLoading) && (
                <View style={[videoStyle.playbackLoading, { backgroundColor: colors.background }]}>
                  {highlightDownload?.status === 'downloading' || playbackLoading ? (
                    <>
                      <ActivityIndicator color={colors.primary} />
                      <Text style={[videoStyle.waitingTitle, { color: colors.foreground }]}>Downloading highlights…</Text>
                      <Text style={[videoStyle.waitingText, { color: colors.mutedForeground }]}>The video will appear here when it is ready.</Text>
                    </>
                  ) : (
                    <>
                      <Feather name="wifi-off" size={28} color={colors.mutedForeground} />
                      <Text style={[videoStyle.waitingTitle, { color: colors.foreground }]}>Waiting to download</Text>
                      <Text style={[videoStyle.waitingText, { color: colors.mutedForeground }]}>
                        Connect to Wi‑Fi, or download now using cellular data.
                      </Text>
                      {!cellularAllowed && (
                        <TouchableOpacity
                          testID="download-highlight-cellular"
                          onPress={async () => {
                            await setCellularAllowed(true);
                            automaticRetryRef.current = false;
                            void loadHighlightVideo(true, Platform.OS === 'ios');
                          }}
                          style={[videoStyle.retryButton, { backgroundColor: colors.primary }]}
                        >
                          <Feather name="download" size={15} color="#fff" />
                          <Text style={videoStyle.retryButtonText}>Download now</Text>
                        </TouchableOpacity>
                      )}
                    </>
                  )}
                </View>
              )}
            </>
          )}
        </ZoomableVideo>
        {Platform.OS !== 'web' && highlightDownload && (
          <View style={videoStyle.downloadedBadge}>
            <Feather name={highlightDownload.status === 'failed' ? 'alert-circle' : highlightDownload.status === 'downloaded' ? 'check-circle' : 'download'} size={14} color={colors.primary} />
            <Text style={[videoStyle.downloadedText, { color: colors.primary }]}>
              {highlightDownload.status === 'downloaded' ? 'Downloaded on this device' : highlightDownload.status === 'failed' ? 'Download failed — tap Retry Video' : `${highlightDownload.status === 'downloading' ? 'Downloading' : 'Queued'} for offline playback`}
            </Text>
          </View>
        )}

        {/* Sharing works without YouTube; YouTube remains an optional destination. */}
        <View style={[ytStyle.bar, { borderTopColor: colors.border, backgroundColor: colors.card }]}>
          <TouchableOpacity
            onPress={handleShareClip}
            disabled={sharingClip}
            style={[ytStyle.btn, { backgroundColor: colors.primary, flex: 1, opacity: sharingClip ? 0.65 : 1 }]}
            activeOpacity={0.8}
          >
            {sharingClip ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Feather name="share-2" size={16} color="#fff" />
            )}
            <Text style={ytStyle.btnText}>{sharingClip ? 'Preparing…' : 'Share Clip'}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID="save-highlight-video"
            onPress={handleSaveClip}
            style={[ytStyle.btn, { backgroundColor: colors.background, borderColor: colors.border, borderWidth: 1, flex: 1 }]}
            activeOpacity={0.8}
          >
            <Feather name="download" size={16} color={colors.foreground} />
            <Text style={[ytStyle.btnText, { color: colors.foreground }]}>Save Video</Text>
          </TouchableOpacity>
          {youtubeUrl ? (
            <TouchableOpacity
              onPress={() => Linking.openURL(youtubeUrl)}
              style={[ytStyle.btn, { backgroundColor: '#FF0000', flex: 1 }]}
              activeOpacity={0.8}
            >
              <Ionicons name="logo-youtube" size={16} color="#fff" />
              <Text style={ytStyle.btnText}>YouTube</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              onPress={() => {
                setUploadTitle('Highlight Reel');
                setUploadModalVisible(true);
              }}
              style={[ytStyle.btn, { backgroundColor: '#FF0000', flex: 1 }]}
              activeOpacity={0.8}
            >
              <Ionicons name="logo-youtube" size={16} color="#fff" />
              <Text style={ytStyle.btnText}>YouTube</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            testID="regenerate-highlights"
            onPress={handleRegenerate}
            disabled={generateMutation.isPending}
            style={[ytStyle.btn, { backgroundColor: colors.background, borderColor: colors.border, borderWidth: 1, flex: 1, opacity: generateMutation.isPending ? 0.55 : 1 }]}
            activeOpacity={0.8}
          >
            {generateMutation.isPending ? (
              <ActivityIndicator size="small" color={colors.foreground} />
            ) : (
              <Ionicons name="refresh-outline" size={16} color={colors.foreground} />
            )}
            <Text style={[ytStyle.btnText, { color: colors.foreground }]}>{generateMutation.isPending ? 'Starting…' : 'Regenerate'}</Text>
          </TouchableOpacity>
        </View>

        {/* Upload modal */}
        <Modal
          visible={uploadModalVisible}
          transparent
          animationType="fade"
          onRequestClose={() => { if (!uploading) setUploadModalVisible(false); }}
        >
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            style={{ flex: 1 }}
          >
            <Pressable
              style={ytStyle.overlay}
              onPress={() => { if (!uploading) setUploadModalVisible(false); }}
            >
              <Pressable
                style={[ytStyle.sheet, { backgroundColor: colors.card, borderColor: colors.border }]}
                onPress={() => {}}
              >
                <Text style={[ytStyle.sheetTitle, { color: colors.foreground }]}>
                  Upload to YouTube
                </Text>

                {/* Title input */}
                <Text style={[ytStyle.fieldLabel, { color: colors.mutedForeground }]}>Title</Text>
                <TextInput
                  style={[ytStyle.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background }]}
                  value={uploadTitle}
                  onChangeText={setUploadTitle}
                  placeholder="Video title"
                  placeholderTextColor={colors.mutedForeground}
                  editable={!uploading}
                  returnKeyType="done"
                />

                {/* Privacy selector */}
                <Text style={[ytStyle.fieldLabel, { color: colors.mutedForeground }]}>Privacy</Text>
                <View style={ytStyle.privacyRow}>
                  {(['public', 'unlisted', 'private'] as PrivacyStatus[]).map((opt) => (
                    <TouchableOpacity
                      key={opt}
                      onPress={() => { if (!uploading) setUploadPrivacy(opt); }}
                      style={[
                        ytStyle.privacyBtn,
                        {
                          borderColor: uploadPrivacy === opt ? colors.primary : colors.border,
                          backgroundColor: uploadPrivacy === opt ? colors.primary + '18' : colors.background,
                        },
                      ]}
                      activeOpacity={0.7}
                    >
                      <Text style={[
                        ytStyle.privacyBtnText,
                        { color: uploadPrivacy === opt ? colors.primary : colors.mutedForeground },
                      ]}>
                        {PRIVACY_LABELS[opt]}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>

                {uploading ? (
                  <View style={{ alignItems: 'center', paddingVertical: 12, gap: 8 }}>
                    <ActivityIndicator color={colors.primary} />
                    <Text style={{ color: colors.mutedForeground, fontSize: 13, fontFamily: 'Inter_400Regular', textAlign: 'center' }}>
                      Uploading to YouTube — this may take a few minutes…
                    </Text>
                  </View>
                ) : (
                  <View style={ytStyle.sheetActions}>
                    <TouchableOpacity
                      onPress={() => setUploadModalVisible(false)}
                      style={[ytStyle.actionBtn, { borderColor: colors.border, backgroundColor: colors.background }]}
                      activeOpacity={0.7}
                    >
                      <Text style={{ color: colors.foreground, fontFamily: 'Inter_500Medium', fontSize: 15 }}>Cancel</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={handleYoutubeUpload}
                      disabled={!uploadTitle.trim()}
                      style={[ytStyle.actionBtn, { backgroundColor: !uploadTitle.trim() ? colors.muted : '#FF0000', borderColor: 'transparent' }]}
                      activeOpacity={0.8}
                    >
                      <Text style={{ color: !uploadTitle.trim() ? colors.mutedForeground : '#fff', fontFamily: 'Inter_600SemiBold', fontSize: 15 }}>
                        Upload
                      </Text>
                    </TouchableOpacity>
                  </View>
                )}
              </Pressable>
            </Pressable>
          </KeyboardAvoidingView>
        </Modal>
      </View>
    );
  }

  if (highlight.status === 'processing') {
    // Synthetic progress — exponential approach towards 97 %.
    // Time constant 2000 s → reaches ~80 % at 54 min, ~92 % at 84 min.
    // Caps below 100 % so the bar never claims done before the server confirms.
    const pct = Math.min(97, Math.round(100 * (1 - Math.exp(-elapsedSec / 2000))));
    const label =
      elapsedSec < 60   ? 'Finding highlight moments…'
      : elapsedSec < 900  ? 'Downloading game footage…'
      : elapsedSec < 4500 ? 'Compressing clips…'
      : 'Finalizing…';
    const mins = Math.floor(elapsedSec / 60);
    const secs = elapsedSec % 60;
    const elapsed = mins > 0
      ? `${mins}m ${String(secs).padStart(2, '0')}s`
      : `${secs}s`;
    return (
      <View style={[videoStyle.empty, { gap: 12, paddingHorizontal: 24 }]}>
        <ActivityIndicator color={colors.primary} size="large" />
        <Text style={[videoStyle.emptyText, { color: colors.foreground, fontFamily: 'Inter_600SemiBold' }]}>
          {label}
        </Text>
        {/* Progress bar */}
        <View style={{ width: '100%', height: 6, backgroundColor: colors.muted, borderRadius: 3, overflow: 'hidden' }}>
          <View style={{ width: `${pct}%`, height: '100%', backgroundColor: colors.primary, borderRadius: 3 }} />
        </View>
        <Text style={[videoStyle.emptyText, { color: colors.mutedForeground, fontSize: 12 }]}>
          {pct}% · {elapsed} elapsed — typically 30–90 min for a full game
        </Text>
        <TouchableOpacity
          testID="cancel-highlights"
          onPress={handleCancelGeneration}
          activeOpacity={0.7}
          style={[reviewAction.cancelButton, { borderColor: colors.border }]}
        >
          <Text style={[reviewAction.cancelText, { color: colors.mutedForeground }]}>Cancel</Text>
        </TouchableOpacity>
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

const reviewAction = StyleSheet.create({
  rowButton: {
    marginHorizontal: 16,
    marginTop: 12,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  rowButtonText: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  cancelButton: { borderWidth: 1, borderRadius: 9, paddingHorizontal: 18, paddingVertical: 9 },
  cancelText: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
});

const ytStyle = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: 1,
    alignItems: 'center',
  },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 10,
    paddingHorizontal: 18,
    paddingVertical: 11,
    minWidth: 130,
    justifyContent: 'center',
  },
  btnText: {
    color: '#fff',
    fontFamily: 'Inter_600SemiBold',
    fontSize: 15,
  },
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  sheet: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 20,
    gap: 12,
  },
  sheetTitle: {
    fontSize: 17,
    fontFamily: 'Inter_700Bold',
    marginBottom: 4,
  },
  fieldLabel: {
    fontSize: 12,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginBottom: -4,
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
  },
  privacyRow: {
    flexDirection: 'row',
    gap: 8,
  },
  privacyBtn: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
  },
  privacyBtnText: {
    fontSize: 13,
    fontFamily: 'Inter_500Medium',
  },
  sheetActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 4,
  },
  actionBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
  },
});
const WEB_BASE = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}`
  : 'https://stecstats.com';

export default function GameDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const gameId = Number(id);
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const [tab, setTab] = useState<Tab>('stats');
  const [isSharing, setIsSharing] = useState(false);
  const { getToken } = useAuth();

  const { data: game, isLoading } = useGetGame(gameId);

  const handleShareBoxScore = useCallback(async () => {
    if (isSharing) return;
    setIsSharing(true);
    try {
      const token = await getToken();
      const res = await fetch(`${API_BASE}/api/games/${gameId}/share-token`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Could not generate share link');
      const { shareToken } = await res.json();
      const url = `${WEB_BASE}/game/${shareToken}`;
      await Share.share({ message: url, url });
    } catch {
      Alert.alert('Share Failed', 'Could not generate a share link. Please try again.');
    } finally {
      setIsSharing(false);
    }
  }, [gameId, getToken, isSharing]);

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
        {(['stats', 'video', 'highlights', 'lowlights'] as Tab[]).map((t) => (
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

      {/* Content — video/highlight/lowlight tabs get a flex container so the
           player fills all remaining space; stats tab stays in a ScrollView */}
      {(tab === 'highlights' || tab === 'lowlights') ? (
        <View style={{ flex: 1 }}>
          {tab === 'highlights' && <HighlightSection gameId={gameId} colors={colors} />}
          {tab === 'lowlights' && <LowlightSection gameId={gameId} colors={colors} />}
        </View>
      ) : (
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
                <>
                  {[...(game.stats as any[])]
                    .sort((a, b) => (b.points ?? 0) - (a.points ?? 0))
                    .map((stat: any, i: number) => (
                      <PlayerStatCard key={stat.playerId} stat={stat} rank={i + 1} colors={colors} />
                    ))}
                  <TeamTotalsRow stats={game.stats as any[]} colors={colors} />
                  <TouchableOpacity
                    onPress={handleShareBoxScore}
                    disabled={isSharing}
                    activeOpacity={0.75}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 8,
                      marginHorizontal: 16,
                      marginTop: 16,
                      paddingVertical: 14,
                      borderRadius: 12,
                      backgroundColor: colors.primary,
                      opacity: isSharing ? 0.6 : 1,
                    }}
                  >
                    {isSharing ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <Feather name="share-2" size={16} color="#fff" />
                    )}
                    <Text style={{ fontFamily: 'Inter_600SemiBold', fontSize: 15, color: '#fff' }}>
                      {isSharing ? 'Generating link…' : 'Share Box Score'}
                    </Text>
                  </TouchableOpacity>
                </>
              )}
            </>
          )}
          {tab === 'video' && <VideoSection game={game} colors={colors} />}
        </ScrollView>
      )}
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
  });
}

const PRIVACY_LABELS: Record<PrivacyStatus, string> = {
  public: 'Public',
  unlisted: 'Unlisted',
  private: 'Private',
};
