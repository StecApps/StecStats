import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
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
import { reelProgressText } from '@/lib/reelProgressText';

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
): Promise<{ url: string; downloadUrl: string; proxyReady: boolean; proxySkipped: boolean; isHls: boolean }> {
  const res = await fetch(`${API_BASE}/api/games/${gameId}/stream-token/${type}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error('Could not get stream token');
  const { token: streamToken, proxyReady, proxySkipped, proxyType, streamUrl, downloadUrl } = await res.json();

  // proxyType==='hls' → long game served as an HLS playlist backed by proxy
  // chunks; AVPlayer on iOS handles M3U8 natively.  Use the playlist URL
  // directly instead of the single-file stream endpoint.
  //
  // Native reel downloads must use the server's GCS-SDK range proxy. Replit's
  // signed object URLs can return the right byte count but incorrect bytes for
  // non-zero Range resumes, producing a locally "complete" MP4 that stops at
  // the resume boundary. Web playback and full-game video retain direct URLs.
  const useReelRangeProxy =
    Platform.OS !== 'web' && (type === 'highlight' || type === 'lowlight');
  const url = proxyType === 'hls'
    ? `${API_BASE}/api/games/${gameId}/hls/playlist.m3u8?t=${streamToken}`
    : useReelRangeProxy
      ? `${API_BASE}/api/games/${gameId}/stream/${type}?t=${streamToken}&proxy=1`
      : (streamUrl ?? `${API_BASE}/api/games/${gameId}/stream/${type}?t=${streamToken}`);

  return {
    url,
    // For reel HLS, streamUrl remains the authenticated resumable MP4 proxy.
    // It is intentionally separate from the native playback playlist.
    downloadUrl: downloadUrl ?? streamUrl ?? `${API_BASE}/api/games/${gameId}/stream/${type}?t=${streamToken}&proxy=1`,
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
  downloadUrl: string;
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

function unsignedStreamIdentity(streamUrl: string) {
  try {
    const parsed = new URL(streamUrl);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return streamUrl.split(/[?#]/, 1)[0];
  }
}

function highlightClipIdentity(index: number, streamUrl: string) {
  return `playback-v1/clip-${index}/${unsignedStreamIdentity(streamUrl)}`;
}

function waitForReelDownload(gameId: number, type: 'highlight' | 'lowlight', objectPath: string) {
  return new Promise<string>((resolve, reject) => {
    const inspect = () => {
      const entry = reelDownloadManager.get(gameId, type, objectPath);
      if (entry?.status === 'downloaded' && entry.uri) {
        unsubscribe();
        resolve(entry.uri);
      } else if (entry?.status === 'failed') {
        unsubscribe();
        reject(new Error(entry.error ?? 'Download failed'));
      }
    };
    const unsubscribe = reelDownloadManager.subscribe(inspect);
    inspect();
  });
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
      downloadUrl: cached.downloadUrl,
      isHls: cached.isHls,
      proxyReady: true,
      proxySkipped: false,
    };
  }

  const result = await fetchStreamUrl(gameId, type, token);
  if (result.proxyReady) {
    streamUrlCache.set(key, {
      url: result.url,
      downloadUrl: result.downloadUrl,
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
    ...StyleSheet.absoluteFillObject,
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
  expandButton: {
    position: 'absolute',
    right: 12,
    top: 12,
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.72)',
  },
  segmentedModal: {
    flex: 1,
    backgroundColor: '#000',
  },
  segmentedModalHeader: {
    position: 'absolute',
    left: 16,
    right: 16,
    top: 18,
    flexDirection: 'row',
    alignItems: 'center',
    pointerEvents: 'box-none',
  },
  modalCloseButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.72)',
  },
  clipProgress: {
    marginLeft: 'auto',
    color: '#fff',
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
    backgroundColor: 'rgba(0,0,0,0.72)',
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 7,
    overflow: 'hidden',
  },
});

function LowlightSection({ gameId, colors }: { gameId: number; colors: any }) {
  const { getToken } = useAuth();
  const { downloads, cellularAllowed, setCellularAllowed } = useReelDownloads();
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;
  const { data: lowlight, refetch } = useGetGameLowlight(gameId);
  const generateMutation = useGenerateGameLowlight();
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [streamIsHls, setStreamIsHls] = useState(false);
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
    if (lowlight?.status !== 'queued' && lowlight?.status !== 'processing') return;
    const timer = setInterval(() => refetch(), 3000);
    return () => clearInterval(timer);
  }, [lowlight?.status]); // eslint-disable-line react-hooks/exhaustive-deps

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
      // Play completed reel HLS immediately on native platforms. Keep the
      // persistent MP4 transfer running independently for Save/offline use.
      if (result.isHls && Platform.OS !== 'web') {
        await reelDownloadManager.enqueue({ gameId, type: 'lowlight', objectPath, url: result.downloadUrl }, true);
        if (!isCurrentLoad()) return;
        setStreamIsHls(true);
        setSignedUrl(result.url);
        setSourceAttachRequest({ url: result.url, id: loadGeneration });
        return;
      }
      const playbackUrl = await getReelPlaybackUrl(gameId, 'lowlight', objectPath, result.downloadUrl, forceFresh);
      if (!isCurrentLoad()) return;
      if (!playbackUrl) {
        setSignedUrl(null);
        setPlaybackLoading(false);
        return;
      }
      setStreamIsHls(false);
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
        await player.replaceAsync(playbackSource(sourceAttachRequest.url, streamIsHls));
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
  }, [player, sourceAttachRequest, streamIsHls]);

  useEffect(() => {
    if (!lowlightReady) return;
    automaticRetryRef.current = false;
    void loadLowlightVideo();
  }, [lowlightReady, gameId, lowlightDownload?.status, lowlightDownload?.uri, loadLowlightVideo]);

  useEffect(() => {
    const subscription = player.addListener('statusChange', ({ status, error }) => {
      if (status !== 'error') return;
      // An empty player can emit a teardown error as this screen unmounts.
      // While the reel is still queued/downloading there is no attached source
      // to repair; forceFresh here would cancel the background transfer, delete
      // its .part file, and restart from byte zero when the game is reopened.
      if (!signedUrl ||
          lowlightDownload?.status === 'queued' ||
          lowlightDownload?.status === 'downloading') return;
      setPlaybackError(error?.message ?? 'The lowlight video could not be loaded.');
      // A local source retry must reattach the same durable file, never use the
      // forceFresh path (which would delete it). Native AVPlayer occasionally
      // reports a transient source error while its surface is remounting.
      if (signedUrl.startsWith('file:')) {
        if (!automaticRetryRef.current) {
          automaticRetryRef.current = true;
          attachedSourceRef.current = null;
          void loadLowlightVideo();
        }
        return;
      }
      if (!automaticRetryRef.current) {
        automaticRetryRef.current = true;
        void loadLowlightVideo(true);
      }
    });
    return () => subscription.remove();
  }, [player, signedUrl, lowlightDownload?.status, loadLowlightVideo]);

  async function handleSaveLowlight() {
    const objectPath = lowlight?.lowlightObjectPath;
    if (!objectPath || !signedUrl) return;
    // Never hand the HLS manifest to the photo-library saver. The parallel
    // token-bound MP4 download is the durable save/offline fallback.
    const saveUrl = streamIsHls
      ? lowlightDownload?.uri ?? await waitForReelDownload(gameId, 'lowlight', objectPath)
      : signedUrl;
    await saveReviewVideo(saveUrl, 'Game Lowlights');
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

  if (lowlight.status === 'queued' || lowlight.status === 'processing') {
    return (
      <View style={[videoStyle.empty, { gap: 12, paddingHorizontal: 24 }]}>
        <ActivityIndicator color={colors.destructive ?? '#ef4444'} size="large" />
        <Text style={[videoStyle.emptyText, { color: colors.foreground, fontFamily: 'Inter_600SemiBold' }]}>
          Preparing Lowlight video…
        </Text>
        <Text style={[videoStyle.emptyText, { color: colors.mutedForeground, fontSize: 12 }]}>
          {lowlight.status === 'queued' ? 'Waiting for an available video worker' : reelProgressText(lowlight)}
        </Text>
        <Text style={[videoStyle.emptyText, { color: colors.mutedForeground, fontSize: 12, textAlign: 'center' }]}>
          You can leave this screen. We’ll notify you when it’s ready.
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
  const [streamIsHls, setStreamIsHls] = useState(false);

  // YouTube upload state — seed from the highlight response so the link
  // persists across remounts (the URL is persisted in the DB on the server).
  const [uploadModalVisible, setUploadModalVisible] = useState(false);
  const [uploadTitle, setUploadTitle] = useState('');
  const [uploadPrivacy, setUploadPrivacy] = useState<PrivacyStatus>('unlisted');
  const [uploading, setUploading] = useState(false);
  const [youtubeUrl, setYoutubeUrl] = useState<string | null>(null);
  const [sharingClip, setSharingClip] = useState(false);
  const [savingClip, setSavingClip] = useState(false);
  const [playbackLoading, setPlaybackLoading] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [playbackInterrupted, setPlaybackInterrupted] = useState(false);
  const [sourceAttachRequest, setSourceAttachRequest] = useState<{ url: string; id: number } | null>(null);
  const automaticRetryRef = useRef(false);
  const loadGenerationRef = useRef(0);
  const sourceAttachGenerationRef = useRef(0);
  const sourceAttachChainRef = useRef<Promise<void>>(Promise.resolve());
  const attachedSourceRef = useRef<string | null>(null);
  const playbackStartedRef = useRef(false);
  const playbackPositionRef = useRef(0);
  const playbackDurationRef = useRef(0);
  const pendingResumePositionRef = useRef(0);
  const reachedEndRef = useRef(false);
  const fullscreenRef = useRef(false);
  const [currentClipPosition, setCurrentClipPosition] = useState(0);
  const [segmentedFullscreenVisible, setSegmentedFullscreenVisible] = useState(false);
  const shouldAutoPlayRef = useRef(false);
  const prefetchedClipRef = useRef<string | null>(null);

  const player = useVideoPlayer('', configureReviewPlayer);

  // Sync stored YouTube URL from the server whenever the highlight data loads.
  useEffect(() => {
    if (highlight?.youtubeUrl && !youtubeUrl) {
      setYoutubeUrl(highlight.youtubeUrl);
    }
  }, [highlight?.youtubeUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll every 3 s while the reel is queued or actively encoding.
  useEffect(() => {
    if (highlight?.status !== 'queued' && highlight?.status !== 'processing') return;
    const timer = setInterval(() => refetch(), 3000);
    return () => clearInterval(timer);
  }, [highlight?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  // Use the stream-token approach (from the seek-fix task) so the video can
  // be seeked without freezing — signed object-storage URLs don't support
  // Range requests reliably in production.
  const highlightReady = highlight?.status === 'ready';
  const segmentedClips = useMemo(
    () => [...(highlight?.clips ?? [])].sort((a, b) => a.index - b.index),
    [highlight?.clips],
  );
  // Generator v11+ rebuilds the combined reel as one continuous CFR H.264/AAC
  // timeline. Prefer that single file on iOS: replacing local sources between
  // standalone clips still halts at 20-second boundaries on physical devices.
  const enableSegmentedIosHighlights = false;
  const usesSegmentedPlayback =
    enableSegmentedIosHighlights &&
    Platform.OS === 'ios' &&
    highlight?.playbackVersion === 1 &&
    segmentedClips.length > 0;
  const currentClip = usesSegmentedPlayback ? segmentedClips[currentClipPosition] : undefined;
  const currentClipObjectPath = currentClip
    ? highlightClipIdentity(currentClip.index, currentClip.streamUrl)
    : null;
  const combinedHighlightDownload = downloads.find((item) =>
    item.gameId === gameId &&
    item.type === 'highlight' &&
    item.objectPath === highlight?.highlightObjectPath);
  const currentClipDownload = currentClipObjectPath
    ? downloads.find((item) =>
        item.gameId === gameId &&
        item.type === 'highlight' &&
        item.objectPath === currentClipObjectPath)
    : undefined;
  const highlightDownload = usesSegmentedPlayback ? currentClipDownload : combinedHighlightDownload;

  const loadHighlightVideo = useCallback(async (
    forceFresh = false,
    disableCaching = false,
  ) => {
    const loadGeneration = ++loadGenerationRef.current;
    const isCurrentLoad = () => loadGeneration === loadGenerationRef.current;
    setPlaybackLoading(true);
    setPlaybackError(null);
    setPlaybackInterrupted(false);
    try {
      if (usesSegmentedPlayback || streamIsHls) {
        if (!currentClip || !currentClipObjectPath) {
          throw new Error('The highlight clip is not available.');
        }
        if (forceFresh) {
          attachedSourceRef.current = null;
          await reelDownloadManager.invalidate(gameId, 'highlight', currentClipObjectPath);
          if (!isCurrentLoad()) return;
        }
        const existing = reelDownloadManager.get(gameId, 'highlight', currentClipObjectPath);
        if (existing?.status === 'downloaded' && existing.uri) {
          setSignedUrl(existing.uri);
          setSourceAttachRequest({ url: existing.uri, id: loadGeneration });
          return;
        }
        await reelDownloadManager.enqueue({
          gameId,
          type: 'highlight',
          objectPath: currentClipObjectPath,
          url: currentClip.streamUrl,
        }, true);
        if (!isCurrentLoad()) return;
        setSignedUrl(null);
        setPlaybackLoading(false);
        return;
      }
      const objectPath = highlight?.highlightObjectPath;
      if (!objectPath) throw new Error('The highlight file is not available.');
      const token = await getTokenRef.current();
      if (!isCurrentLoad()) return;
      if (!token) throw new Error('Your session expired. Please sign in again.');

      if (forceFresh) {
        attachedSourceRef.current = null;
        pendingResumePositionRef.current = 0;
        playbackStartedRef.current = false;
        playbackPositionRef.current = 0;
        playbackDurationRef.current = 0;
        reachedEndRef.current = false;
        streamUrlCache.delete(streamCacheKey(gameId, 'highlight'));
        await reelDownloadManager.invalidate(gameId, 'highlight', objectPath);
        if (!isCurrentLoad()) return;
      }
      const result = forceFresh
        ? await fetchStreamUrl(gameId, 'highlight', token)
        : await getReusableStreamUrl(gameId, 'highlight', token);
      if (!isCurrentLoad()) return;

      if (result.isHls && Platform.OS !== 'web') {
        await reelDownloadManager.enqueue({ gameId, type: 'highlight', objectPath, url: result.downloadUrl }, true);
        if (!isCurrentLoad()) return;
        setStreamIsHls(true);
        setSignedUrl(result.url);
        setSourceAttachRequest({ url: result.url, id: loadGeneration });
        return;
      }
      const playbackUrl = await getReelPlaybackUrl(
        gameId,
        'highlight',
        objectPath,
        result.downloadUrl,
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
          downloadUrl: result.downloadUrl,
          isHls: result.isHls,
          expiresAt: Date.now() + STREAM_URL_REUSE_MS,
        });
      }
      setStreamIsHls(false);
      setSignedUrl(playbackUrl);
      setSourceAttachRequest({ url: playbackUrl, id: loadGeneration });
    } catch (error: any) {
      if (!isCurrentLoad()) return;
      setSignedUrl(null);
      setPlaybackError(error?.message ?? 'The highlight video could not be loaded.');
      setPlaybackLoading(false);
    }
  }, [
    gameId,
    highlight?.highlightObjectPath,
    player,
    usesSegmentedPlayback,
    currentClip?.index,
    currentClip?.streamUrl,
    currentClipObjectPath,
  ]);

  useEffect(() => () => {
    loadGenerationRef.current++;
    sourceAttachGenerationRef.current++;
    attachedSourceRef.current = null;
  }, [highlight?.highlightObjectPath, currentClipObjectPath]);

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
        const resumePosition = pendingResumePositionRef.current;
        playbackStartedRef.current = false;
        reachedEndRef.current = false;
        if (resumePosition <= 0) {
          playbackPositionRef.current = 0;
          playbackDurationRef.current = 0;
        }
        await player.replaceAsync(playbackSource(sourceAttachRequest.url, streamIsHls));
        if (cancelled || generation !== sourceAttachGenerationRef.current) return;
        attachedSourceRef.current = sourceAttachRequest.url;
        playbackDurationRef.current = Number.isFinite(player.duration) ? player.duration : 0;
        pendingResumePositionRef.current = 0;
        if (resumePosition > 0.25) {
          const duration = playbackDurationRef.current;
          const safeResumePosition = duration > 1
            ? Math.min(resumePosition, duration - 1)
            : resumePosition;
          player.currentTime = Math.max(0, safeResumePosition - 0.25);
          playbackPositionRef.current = player.currentTime;
          playbackStartedRef.current = true;
          player.play();
        } else if (shouldAutoPlayRef.current) {
          shouldAutoPlayRef.current = false;
          player.play();
        }
        setPlaybackLoading(false);
      })
      .catch((error: any) => {
        if (cancelled || generation !== sourceAttachGenerationRef.current) return;
        setPlaybackError(error?.message ?? 'The highlight video could not be loaded.');
        setPlaybackLoading(false);
      });
    return () => { cancelled = true; };
  }, [player, sourceAttachRequest, streamIsHls]);

  useEffect(() => {
    if (!highlightReady) return;
    let cancelled = false;
    automaticRetryRef.current = false;
    void loadHighlightVideo().then(() => {
      if (cancelled) return;
    });
    return () => { cancelled = true; };
  }, [highlightReady, gameId, highlightDownload?.status, highlightDownload?.uri, loadHighlightVideo]);

  // Keep enough native playback state to distinguish an initial source failure
  // from an interruption after AVPlayer has already shown valid frames. Retrying
  // the latter automatically replaces the active source and dismisses iOS
  // fullscreen playback even though the downloaded MP4 is still valid.
  useEffect(() => {
    player.timeUpdateEventInterval = 0.5;
    const advanceSegmentedClip = () => {
      if (
        !usesSegmentedPlayback ||
        reachedEndRef.current ||
        currentClipPosition >= segmentedClips.length - 1
      ) {
        return false;
      }
      reachedEndRef.current = true;
      shouldAutoPlayRef.current = true;
      attachedSourceRef.current = null;
      setPlaybackError(null);
      setPlaybackInterrupted(false);
      setCurrentClipPosition((position) => position + 1);
      return true;
    };
    const timeSubscription = player.addListener('timeUpdate', ({ currentTime }) => {
      if (Number.isFinite(currentTime)) {
        playbackPositionRef.current = currentTime;
        if (currentTime > 0.25) playbackStartedRef.current = true;
        // AVPlayer occasionally reaches the final frame of a local MP4 without
        // Expo Video forwarding playToEnd. Use the server-validated manifest
        // duration as a guarded fallback so segmented playback still advances.
        const expectedEnd = (currentClip?.durationMs ?? 0) / 1000;
        if (
          expectedEnd > 0 &&
          currentTime >= expectedEnd - 0.15
        ) {
          advanceSegmentedClip();
        }
      }
      if (Number.isFinite(player.duration) && player.duration > 0) {
        playbackDurationRef.current = player.duration;
      }
    });
    const playingSubscription = player.addListener('playingChange', ({ isPlaying }) => {
      if (isPlaying) {
        playbackStartedRef.current = true;
        if (usesSegmentedPlayback) {
          const nextClip = segmentedClips[currentClipPosition + 1];
          if (nextClip) {
            const nextObjectPath = highlightClipIdentity(nextClip.index, nextClip.streamUrl);
            if (prefetchedClipRef.current !== nextObjectPath) {
              prefetchedClipRef.current = nextObjectPath;
              void reelDownloadManager.enqueue({
                gameId,
                type: 'highlight',
                objectPath: nextObjectPath,
                url: nextClip.streamUrl,
              });
            }
          }
        }
      } else if (usesSegmentedPlayback && playbackStartedRef.current) {
        // Some iOS versions emit neither playToEnd nor a final timeUpdate for a
        // local MP4. playingChange still arrives after AVPlayer reaches its final
        // frame, and player.currentTime has the terminal position by then.
        const expectedEnd = (currentClip?.durationMs ?? 0) / 1000;
        if (
          expectedEnd > 0 &&
          player.currentTime >= expectedEnd - 0.35
        ) {
          advanceSegmentedClip();
        }
      }
    });
    const endSubscription = player.addListener('playToEnd', () => {
      if (advanceSegmentedClip()) return;
      reachedEndRef.current = true;
      if (Number.isFinite(player.duration) && player.duration > 0) {
        playbackDurationRef.current = player.duration;
        playbackPositionRef.current = player.duration;
      }
    });
    return () => {
      timeSubscription.remove();
      playingSubscription.remove();
      endSubscription.remove();
    };
  }, [
    player,
    usesSegmentedPlayback,
    segmentedClips,
    currentClipPosition,
    currentClip?.durationMs,
    gameId,
  ]);

  // AVPlayer can reject a signed source after Expo Video has accepted it, so
  // replaceAsync resolving is not sufficient proof that playback is available.
  // Retry once with a fresh URL and native caching disabled; this bypasses a
  // stale/corrupt cache entry while preserving caching for the normal path.
  useEffect(() => {
    const subscription = player.addListener('statusChange', ({ status, error }) => {
      if (status !== 'error') return;
      // Ignore native player teardown errors until there is a real attached
      // source. Retrying an empty/downloading player is destructive because
      // forceFresh invalidates the active background download and its .part.
      if (!signedUrl ||
          highlightDownload?.status === 'queued' ||
          highlightDownload?.status === 'downloading') return;
      const message = error?.message ?? 'The highlight video could not be loaded.';
      const interruptedLocalPlayback = signedUrl.startsWith('file:') &&
        (playbackStartedRef.current || playbackPositionRef.current > 0.25);
      console.warn('[HighlightPlayback] AVPlayer error', {
        gameId,
        currentTime: playbackPositionRef.current,
        duration: playbackDurationRef.current || player.duration,
        fullscreen: fullscreenRef.current,
        message,
      });
      // Recover one unexpected local interruption automatically from the last
      // known timestamp. This reattaches the same durable file; it never
      // invalidates the download or requests media bytes again.
      if (interruptedLocalPlayback && !automaticRetryRef.current) {
        automaticRetryRef.current = true;
        pendingResumePositionRef.current = playbackPositionRef.current;
        shouldAutoPlayRef.current = true;
        attachedSourceRef.current = null;
        setPlaybackInterrupted(false);
        setPlaybackError(null);
        setPlaybackLoading(true);
        void loadHighlightVideo();
        return;
      }
      setPlaybackInterrupted(interruptedLocalPlayback);
      setPlaybackError(message);
      if (interruptedLocalPlayback) return;
      // Reattach a completed local MP4 once after a transient native source
      // error. In particular, do not call forceFresh: that would delete the
      // durable file while AVPlayer may still have it open.
      if (signedUrl.startsWith('file:')) {
        if (usesSegmentedPlayback) return;
        if (!automaticRetryRef.current) {
          automaticRetryRef.current = true;
          attachedSourceRef.current = null;
          void loadHighlightVideo();
        }
        return;
      }
      if (!automaticRetryRef.current) {
        automaticRetryRef.current = true;
        void loadHighlightVideo(true, Platform.OS === 'ios');
      }
    });
    return () => subscription.remove();
  }, [player, signedUrl, highlightDownload?.status, loadHighlightVideo, gameId, usesSegmentedPlayback]);

  function handleRetryHighlightPlayback() {
    automaticRetryRef.current = false;
    if (playbackInterrupted && signedUrl?.startsWith('file:')) {
      pendingResumePositionRef.current = playbackPositionRef.current;
      attachedSourceRef.current = null;
      setPlaybackError(null);
      setPlaybackInterrupted(false);
      void loadHighlightVideo();
      return;
    }
    void loadHighlightVideo(true, Platform.OS === 'ios');
  }

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
    if (savingClip) return;
    setSavingClip(true);
    try {
      let saveUrl = signedUrl;
      if (usesSegmentedPlayback) {
        const objectPath = highlight?.highlightObjectPath;
        if (!objectPath) throw new Error('The combined highlight is not available.');
        const downloaded = reelDownloadManager.get(gameId, 'highlight', objectPath);
        if (downloaded?.status === 'downloaded' && downloaded.uri) {
          saveUrl = downloaded.uri;
        } else {
          const token = await getTokenRef.current();
          if (!token) throw new Error('Your session expired. Please sign in again.');
          const result = await getReusableStreamUrl(gameId, 'highlight', token);
          if (Platform.OS === 'web') {
            saveUrl = result.url;
          } else {
            await reelDownloadManager.enqueue({
              gameId,
              type: 'highlight',
              objectPath,
              url: result.downloadUrl,
            }, true);
            saveUrl = await waitForReelDownload(gameId, 'highlight', objectPath);
          }
        }
      }
      if (!saveUrl) throw new Error('The highlight video is not ready.');
      await saveReviewVideo(saveUrl, 'Game Highlights');
    } catch (error: any) {
      Alert.alert('Save Failed', error?.message ?? 'The highlight video could not be saved.');
    } finally {
      setSavingClip(false);
    }
  }

  async function handleRegenerate() {
    if (generateMutation.isPending) return;
    try {
      attachedSourceRef.current = null;
      await reelDownloadManager.invalidate(gameId, 'highlight', highlight?.highlightObjectPath);
      streamUrlCache.delete(streamCacheKey(gameId, 'highlight'));
      setSignedUrl(null);
      setCurrentClipPosition(0);
      setSegmentedFullscreenVisible(false);
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
        {/* Segmented iOS playback deliberately never enters AVPlayerViewController. */}
        <ZoomableVideo style={{ flex: 1 }}>
          {!segmentedFullscreenVisible && <VideoView
            player={player}
            style={{ flex: 1 }}
            contentFit="cover"
            fullscreenOptions={{ enable: !usesSegmentedPlayback, autoExitOnRotate: false }}
            allowsPictureInPicture
            nativeControls
            onFirstFrameRender={() => {
              playbackStartedRef.current = true;
              if (Number.isFinite(player.duration) && player.duration > 0) {
                playbackDurationRef.current = player.duration;
              }
            }}
            onFullscreenEnter={() => {
              fullscreenRef.current = true;
            }}
            onFullscreenExit={() => {
              fullscreenRef.current = false;
              console.info('[HighlightPlayback] Fullscreen exited', {
                gameId,
                currentTime: playbackPositionRef.current,
                duration: playbackDurationRef.current || player.duration,
                reachedEnd: reachedEndRef.current,
              });
            }}
          />}
          {usesSegmentedPlayback && !segmentedFullscreenVisible && (
            <TouchableOpacity
              testID="expand-segmented-highlight"
              accessibilityLabel="Open highlight full screen"
              onPress={() => setSegmentedFullscreenVisible(true)}
              style={videoStyle.expandButton}
            >
              <Feather name="maximize" size={20} color="#fff" />
            </TouchableOpacity>
          )}
          {playbackError && !playbackLoading ? (
            <View style={[videoStyle.playbackError, { backgroundColor: colors.background }]}>
              <Feather name="alert-circle" size={28} color={colors.mutedForeground} />
              <Text style={[videoStyle.playbackErrorText, { color: colors.foreground }]}>
                {playbackInterrupted
                  ? `Playback was interrupted at ${formatReviewTime(playbackPositionRef.current)}. The complete Highlight is still downloaded on this device.`
                  : 'This highlight could not be loaded.'}
              </Text>
              <TouchableOpacity
                testID="retry-highlight-playback"
                onPress={handleRetryHighlightPlayback}
                style={[videoStyle.retryButton, { backgroundColor: colors.primary }]}
              >
                <Feather name={playbackInterrupted ? 'play' : 'refresh-cw'} size={15} color="#fff" />
                <Text style={videoStyle.retryButtonText}>
                  {playbackInterrupted ? 'Resume Playback' : 'Retry Video'}
                </Text>
              </TouchableOpacity>
            </View>
          ) : (!signedUrl || playbackLoading) && (
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
        </ZoomableVideo>
        {usesSegmentedPlayback && segmentedFullscreenVisible && (
          <Modal
            testID="segmented-highlight-modal"
            visible
            animationType="fade"
            supportedOrientations={['portrait', 'landscape']}
            onRequestClose={() => setSegmentedFullscreenVisible(false)}
          >
            <View style={videoStyle.segmentedModal}>
              <VideoView
                player={player}
                style={StyleSheet.absoluteFill}
                contentFit="contain"
                fullscreenOptions={{ enable: false }}
                nativeControls
                allowsPictureInPicture
              />
              <View style={videoStyle.segmentedModalHeader}>
                <TouchableOpacity
                  testID="close-segmented-highlight"
                  accessibilityLabel="Close full screen highlight"
                  onPress={() => setSegmentedFullscreenVisible(false)}
                  style={videoStyle.modalCloseButton}
                >
                  <Feather name="x" size={24} color="#fff" />
                </TouchableOpacity>
                <Text style={videoStyle.clipProgress}>
                  Clip {currentClipPosition + 1} of {segmentedClips.length}
                </Text>
              </View>
            </View>
          </Modal>
        )}
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
            disabled={savingClip}
            style={[ytStyle.btn, { backgroundColor: colors.background, borderColor: colors.border, borderWidth: 1, flex: 1 }]}
            activeOpacity={0.8}
          >
            {savingClip ? <ActivityIndicator size="small" color={colors.foreground} /> : <Feather name="download" size={16} color={colors.foreground} />}
            <Text style={[ytStyle.btnText, { color: colors.foreground }]}>{savingClip ? 'Saving…' : 'Save Video'}</Text>
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

  if (highlight.status === 'queued') {
    return (
      <View style={[videoStyle.empty, { gap: 12, paddingHorizontal: 24 }]}>
        <ActivityIndicator color={colors.primary} size="large" />
        <Text style={[videoStyle.emptyText, { color: colors.foreground, fontFamily: 'Inter_600SemiBold' }]}>
          Highlight queued
        </Text>
        <Text style={[videoStyle.emptyText, { color: colors.mutedForeground, fontSize: 12, textAlign: 'center' }]}>
          All video workers are busy. Encoding will start automatically when a spot opens.
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

  if (highlight.status === 'processing') {
    return (
      <View style={[videoStyle.empty, { gap: 12, paddingHorizontal: 24 }]}>
        <ActivityIndicator color={colors.primary} size="large" />
        <Text style={[videoStyle.emptyText, { color: colors.foreground, fontFamily: 'Inter_600SemiBold' }]}>
          Preparing Highlight video…
        </Text>
        <Text style={[videoStyle.emptyText, { color: colors.mutedForeground, fontSize: 12 }]}>
          {reelProgressText(highlight)}
        </Text>
        <Text style={[videoStyle.emptyText, { color: colors.mutedForeground, fontSize: 12, textAlign: 'center' }]}>
          You can leave this screen. We’ll notify you when it’s ready.
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
