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
import { VideoView, useVideoPlayer } from 'expo-video';
import { useAuth } from '@clerk/clerk-expo';
import { ZoomableVideo } from '@/components/ZoomableVideo';

const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}`
  : '';

async function fetchStreamUrl(gameId: number, type: 'video' | 'highlight' | 'lowlight', token: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/games/${gameId}/stream-token/${type}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error('Could not get stream token');
  const { token: streamToken } = await res.json();
  return `${API_BASE}/api/games/${gameId}/stream/${type}?t=${streamToken}`;
}

type Tab = 'stats' | 'video' | 'highlights' | 'lowlights';

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
  const [loadError, setLoadError] = useState(false);

  const player = useVideoPlayer('', () => {});

  useEffect(() => {
    if (!game.videoObjectPath) return;
    let cancelled = false;
    getToken()
      .then((token) => {
        if (!token || cancelled) return;
        return fetchStreamUrl(game.id, 'video', token);
      })
      .then((url) => {
        if (!url || cancelled) return;
        setStreamUrl(url);
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

  if (!streamUrl) {
    return <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />;
  }

  return (
    <ZoomableVideo style={videoStyle.wrap}>
      <VideoView
        player={player}
        style={videoStyle.video}
        contentFit="cover"
        allowsFullscreen
        allowsPictureInPicture
      />
    </ZoomableVideo>
  );
}

const videoStyle = StyleSheet.create({
  wrap: { marginHorizontal: 16, marginTop: 16, borderRadius: 12, overflow: 'hidden' },
  video: { width: '100%', aspectRatio: 16 / 9, backgroundColor: '#000' },
  empty: { alignItems: 'center', paddingTop: 60, gap: 12 },
  emptyText: { fontSize: 15, fontFamily: 'Inter_400Regular' },
});

// Module-level maps so processing start times survive tab-switches/remounts.
// Separate maps for highlight vs lowlight so they don't interfere.
const processingStartTimes    = new Map<number, number>();
const lowlightStartTimes      = new Map<number, number>();

function LowlightSection({ gameId, colors }: { gameId: number; colors: any }) {
  const { getToken } = useAuth();
  const { data: lowlight, refetch } = useGetGameLowlight(gameId);
  const generateMutation = useGenerateGameLowlight();
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);

  const player = useVideoPlayer('', () => {});

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

  useEffect(() => {
    if (!lowlightReady) return;
    let cancelled = false;
    getToken()
      .then((token) => {
        if (!token || cancelled) return;
        return fetchStreamUrl(gameId, 'lowlight', token);
      })
      .then((url) => {
        if (!url || cancelled) return;
        setSignedUrl(url);
        player.replace({ uri: url });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [lowlightReady, gameId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!lowlight) return <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />;

  if (lowlight.status === 'ready') {
    if (!signedUrl) return <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />;
    return (
      <ZoomableVideo style={{ flex: 1, backgroundColor: colors.card }}>
        <VideoView
          player={player}
          style={{ flex: 1 }}
          contentFit="contain"
          allowsFullscreen
          allowsPictureInPicture
          nativeControls
        />
      </ZoomableVideo>
    );
  }

  if (lowlight.status === 'processing') {
    const pct = Math.min(92, Math.round(100 * (1 - Math.exp(-elapsedSec / 900))));
    const label =
      elapsedSec < 30   ? 'Finding missed shots & turnovers…'
      : elapsedSec < 360  ? 'Downloading game footage…'
      : elapsedSec < 2700 ? 'Compressing clips…'
      : elapsedSec < 3300 ? 'Encoding reel…'
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
          {pct}% · {elapsed} elapsed — typically 5–15 min for a full game
        </Text>
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

  const player = useVideoPlayer('', () => {});

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

  useEffect(() => {
    if (!highlightReady) return;
    let cancelled = false;
    getToken()
      .then((token) => {
        if (!token || cancelled) return;
        return fetchStreamUrl(gameId, 'highlight', token);
      })
      .then((url) => {
        if (!url || cancelled) return;
        setSignedUrl(url);
        player.replace({ uri: url });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [highlightReady, gameId]); // eslint-disable-line react-hooks/exhaustive-deps

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

  if (!highlight) return <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />;

  if (highlight.status === 'ready') {
    if (!signedUrl) return <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />;
    return (
      <View style={{ flex: 1, backgroundColor: colors.card }}>
        {/* ZoomableVideo from the pinch-to-zoom task wraps only the player */}
        <ZoomableVideo style={{ flex: 1 }}>
          <VideoView
            player={player}
            style={{ flex: 1 }}
            contentFit="contain"
            allowsFullscreen
            allowsPictureInPicture
            nativeControls
          />
        </ZoomableVideo>

        {/* YouTube upload row */}
        <View style={[ytStyle.bar, { borderTopColor: colors.border, backgroundColor: colors.card }]}>
          {youtubeUrl ? (
            <>
              <TouchableOpacity
                onPress={() => Linking.openURL(youtubeUrl)}
                style={[ytStyle.btn, { backgroundColor: '#FF0000', flex: 1 }]}
                activeOpacity={0.8}
              >
                <Ionicons name="logo-youtube" size={16} color="#fff" />
                <Text style={ytStyle.btnText}>View on YouTube</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() =>
                  Share.share({
                    message: `Watch our game highlights: ${youtubeUrl}`,
                    url: youtubeUrl,
                  })
                }
                style={[ytStyle.btn, { backgroundColor: colors.muted }]}
                activeOpacity={0.8}
              >
                <Feather name="share-2" size={16} color={colors.foreground} />
                <Text style={[ytStyle.btnText, { color: colors.foreground }]}>Share</Text>
              </TouchableOpacity>
            </>
          ) : (
            <TouchableOpacity
              onPress={() => {
                setUploadTitle('Highlight Reel');
                setUploadModalVisible(true);
              }}
              style={[ytStyle.btn, { backgroundColor: '#FF0000' }]}
              activeOpacity={0.8}
            >
              <Ionicons name="logo-youtube" size={16} color="#fff" />
              <Text style={ytStyle.btnText}>Upload to YouTube</Text>
            </TouchableOpacity>
          )}
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
    // Synthetic progress — exponential approach towards 92 %
    // (same formula as the web app). Caps so it never reaches 100 %
    // until the server says "ready".
    const pct = Math.min(92, Math.round(100 * (1 - Math.exp(-elapsedSec / 900))));
    const label =
      elapsedSec < 30  ? 'Finding highlight moments…'
      : elapsedSec < 360  ? 'Downloading game footage…'
      : elapsedSec < 2700 ? 'Compressing clips…'
      : elapsedSec < 3300 ? 'Encoding reel…'
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
          {pct}% · {elapsed} elapsed — typically 5–15 min for a full game
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

const ytStyle = StyleSheet.create({
  bar: {
    flexDirection: 'row',
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
