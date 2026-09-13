import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Platform,
  Alert,
  Share,
  useWindowDimensions,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import { enqueuePhoto, dequeuePhoto } from '@/lib/pendingPhotoQueue';
import { uploadPhoto, API_BASE } from '@/lib/photoUpload';
import Svg, { Circle, G, Path, Rect } from 'react-native-svg';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import { useAuth, useUser } from '@clerk/expo';
import {
  useListPlayers,
  useGetPlayerSummary,
  useUpdatePlayer,
  getListPlayersQueryKey,
  useGetMe,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { tekoStyle } from '@/lib/tekoStyle';
import { GlossyButton } from '@/components/GlossyButton';

// ─── Theme helpers ────────────────────────────────────────────────────────────
function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function photoSrc(objectPath: string) {
  return `${API_BASE}/api/storage/objects/${objectPath.replace(/^\/objects\//, '')}`;
}

function ScreenGlow({ primary }: { primary: string }) {
  const rgba = (alpha: number) => hexToRgba(primary, alpha);
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFillObject}>
      <LinearGradient
        colors={[rgba(0.38), rgba(0.18), rgba(0.06), rgba(0)]}
        locations={[0, 0.22, 0.45, 0.70]}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
        style={StyleSheet.absoluteFillObject}
      />
      <LinearGradient
        colors={[rgba(0.14), rgba(0)]}
        locations={[0, 0.5]}
        start={{ x: 0.75, y: 0 }}
        end={{ x: 0.25, y: 0.5 }}
        style={StyleSheet.absoluteFillObject}
      />
    </View>
  );
}

function BasketballWatermark({ color }: { color: string }) {
  const size = 340, center = size / 2, radius = 155, strokeWidth = 9;
  return (
    <View pointerEvents="none" style={{ position: 'absolute', top: -60, right: -100, width: size, height: size, opacity: 0.11 }}>
      <Svg width={size} height={size}>
        <Circle cx={center} cy={center} r={radius} stroke={color} strokeWidth={strokeWidth} fill="none" />
        <Path d={`M${center},${center - radius} C${center - 62},${center - radius * 0.38} ${center + 62},${center + radius * 0.38} ${center},${center + radius}`} stroke={color} strokeWidth={strokeWidth} fill="none" strokeLinecap="round" />
        <Path d={`M${center - radius},${center} Q${center},${center - radius * 0.68} ${center + radius},${center}`} stroke={color} strokeWidth={strokeWidth} fill="none" strokeLinecap="round" />
        <Path d={`M${center - radius},${center} Q${center},${center + radius * 0.68} ${center + radius},${center}`} stroke={color} strokeWidth={strokeWidth} fill="none" strokeLinecap="round" />
      </Svg>
    </View>
  );
}

function StatsWatermark({ color }: { color: string }) {
  const bars: [number, number][] = [[0.50, 0], [0.78, 1], [0.40, 2], [0.92, 3], [0.65, 4]];
  return (
    <View pointerEvents="none" style={{ position: 'absolute', bottom: 120, right: -10, width: 180, height: 140, opacity: 0.055 }}>
      <Svg width={180} height={140}>
        {bars.map(([height, index]) => {
          const barHeight = height * 100;
          return <Rect key={index} x={10 + index * 38} y={120 - barHeight} width={26} height={barHeight} rx={5} fill={color} />;
        })}
      </Svg>
    </View>
  );
}

// ─── Arc Gauge ───────────────────────────────────────────────────────────────
function ArcGauge({
  pct, label, made, attempted,
}: {
  pct?: number | null; label: string; made?: number; attempted?: number;
}) {
  const c = useColors();
  const SIZE = 96, SW = 8;
  const r = (SIZE - SW) / 2;
  const circ = 2 * Math.PI * r;
  const filled = Math.max(0, Math.min(1, pct ?? 0)) * circ;
  const pctStr = pct != null && pct > 0 ? `${(pct * 100).toFixed(1)}%` : '—';

  return (
    <View style={gaugeS.wrap}>
      <View style={{ width: SIZE, height: SIZE }}>
        <Svg width={SIZE} height={SIZE}>
          <G rotation="-90" origin={`${SIZE / 2},${SIZE / 2}`}>
            <Circle cx={SIZE/2} cy={SIZE/2} r={r}
              stroke={c.border} strokeWidth={SW} fill="none" />
            <Circle cx={SIZE/2} cy={SIZE/2} r={r}
              stroke={c.primary} strokeWidth={SW} fill="none"
              strokeDasharray={`${filled} ${circ}`} strokeLinecap="round" />
          </G>
        </Svg>
        <View style={gaugeS.center}>
          <Text style={[gaugeS.pctNum, { color: c.foreground }]}>{pctStr}</Text>
          {made != null && attempted != null && (
            <Text style={[gaugeS.madeFrac, { color: c.mutedForeground }]}>{made}/{attempted}</Text>
          )}
        </View>
      </View>
      <Text style={[gaugeS.label, { color: c.mutedForeground }]}>{label.toUpperCase()}</Text>
    </View>
  );
}
const gaugeS = StyleSheet.create({
  wrap:     { alignItems: 'center', flex: 1 },
  center:   { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  pctNum:   { ...tekoStyle(24) },
  madeFrac: { fontSize: 9, fontFamily: 'Inter_500Medium', marginTop: -2 },
  label:    { fontSize: 10, fontFamily: 'Inter_700Bold', letterSpacing: 1, marginTop: 12 },
});

// ─── Player chip ─────────────────────────────────────────────────────────────
function PlayerChip({ player, isSelected, onPress, glossy = false }: { player: any; isSelected: boolean; onPress: () => void; glossy?: boolean }) {
  const c = useColors();
  const { data: summary } = useGetPlayerSummary(player.id);
  const content = (
    <>
      <Text style={[chipS.name, { color: isSelected ? c.primaryForeground : c.foreground }]}>
        {player.name}
      </Text>
      <Text style={[chipS.sub, { color: isSelected ? 'rgba(255,255,255,0.78)' : c.mutedForeground }]}>
        {summary ? `${summary.games}GP · ${summary.ppg.toFixed(1)}PPG` : '…'}
      </Text>
    </>
  );

  if (glossy) {
    return (
      <GlossyButton onPress={onPress} selected={isSelected} style={chipS.chip}>
        {content}
      </GlossyButton>
    );
  }

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.75}
      style={[
        chipS.chip,
        {
          backgroundColor: isSelected ? c.primary : c.card,
          borderColor: isSelected ? c.primary : c.border,
        },
      ]}
    >
      {content}
    </TouchableOpacity>
  );
}
const chipS = StyleSheet.create({
  chip: {
    minWidth: 132,
    minHeight: 58,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 999,
    borderWidth: 1,
    marginRight: 8,
  },
  name: { fontSize: 15, fontFamily: 'Inter_700Bold' },
  sub: { fontSize: 11, fontFamily: 'Inter_500Medium', marginTop: 3 },
});

// ─── Unified Stat Card (Desktop style) ───────────────────────────────────────
function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  const c = useColors();
  return (
    <View style={[statS.card, { borderColor: c.border, backgroundColor: c.card }]}>
      <Text style={[statS.label, { color: c.mutedForeground }]}>{label}</Text>
      <View style={statS.bottomRow}>
        <Text style={[statS.value, { color: c.foreground }]}>{value}</Text>
        {sub && <Text style={[statS.sub, { color: c.mutedForeground }]}>{sub}</Text>}
      </View>
    </View>
  );
}
const statS = StyleSheet.create({
  card:  { flex: 1, borderRadius: 6, borderWidth: 1, padding: 12, justifyContent: 'space-between', minHeight: 84 },
  label: { fontSize: 10, fontFamily: 'Inter_700Bold', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 12 },
  bottomRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  value: { ...tekoStyle(34) },
  sub:   { fontSize: 10, fontFamily: 'Inter_500Medium', paddingBottom: 4 },
});

// ─── Section header ───────────────────────────────────────────────────────────
function SectionHeader({ title, flush = false }: { title: string; flush?: boolean }) {
  const c = useColors();
  return (
    <View style={[secS.row, flush && secS.rowFlush]}>
      <Text style={[secS.title, { color: c.foreground }]}>{title.toUpperCase()}</Text>
      <View style={{ flex: 1, height: 1, backgroundColor: c.primary, marginLeft: 16 }} />
    </View>
  );
}
const secS = StyleSheet.create({
  row:   { flexDirection: 'row', alignItems: 'center', marginBottom: 16, marginTop: 32 },
  rowFlush: { marginBottom: 0 },
  title: { fontSize: 14, fontFamily: 'Inter_700Bold', letterSpacing: 1.5 },
});

// ─── Compact shooting strip (landscape-only) ─────────────────────────────────
function CompactShootingStrip({
  fgMade, fgAtt, threeMade, threeAtt, ftMade, ftAtt,
}: {
  fgMade: number; fgAtt: number;
  threeMade: number; threeAtt: number;
  ftMade: number; ftAtt: number;
}) {
  const c = useColors();
  const fmt = (made: number, att: number) =>
    att > 0 ? `${(made / att * 100).toFixed(1)}%` : '—';
  const cells = [
    { label: 'FG%',  val: fmt(fgMade, fgAtt),       frac: `${fgMade}/${fgAtt}` },
    { label: '3P%',  val: fmt(threeMade, threeAtt),  frac: `${threeMade}/${threeAtt}` },
    { label: 'FT%',  val: fmt(ftMade, ftAtt),        frac: `${ftMade}/${ftAtt}` },
  ];
  return (
    <View style={[cShootS.row, { borderColor: c.border, backgroundColor: c.card }]}>
      {cells.map((cell, i) => (
        <React.Fragment key={cell.label}>
          <View style={cShootS.cell}>
            <Text style={[cShootS.label, { color: c.mutedForeground }]}>{cell.label}</Text>
            <View style={cShootS.valRow}>
              <Text style={[cShootS.value, { color: c.foreground }]}>{cell.val}</Text>
              <Text style={[cShootS.frac, { color: c.mutedForeground }]}>{cell.frac}</Text>
            </View>
          </View>
          {i < cells.length - 1 && (
            <View style={[cShootS.divider, { backgroundColor: c.border }]} />
          )}
        </React.Fragment>
      ))}
    </View>
  );
}
const cShootS = StyleSheet.create({
  row:     { flexDirection: 'row', borderRadius: 6, borderWidth: 1, padding: 16, alignItems: 'center' },
  cell:    { flex: 1, alignItems: 'flex-start', paddingLeft: 16 },
  label:   { fontSize: 10, fontFamily: 'Inter_700Bold', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 4 },
  valRow:  { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  value:   { ...tekoStyle(30) },
  frac:    { fontSize: 10, fontFamily: 'Inter_500Medium' },
  divider: { width: 1, alignSelf: 'stretch', marginHorizontal: 8 },
});

// ─── Console Stat (iPad) ──────────────────────────────────────────────────────
function ConsoleStat({ label, value, sub, accent = false }: { label: string; value: string; sub: string; accent?: boolean }) {
  const c = useColors();
  return (
    <View style={cStatS.cell}>
      {accent && <View style={[cStatS.accentBar, { backgroundColor: c.primary }]} />}
      <Text style={[cStatS.label, { color: accent ? c.primary : c.mutedForeground }]}>{label}</Text>
      <Text style={[cStatS.value, { color: c.foreground }]} adjustsFontSizeToFit numberOfLines={1}>{value}</Text>
      <Text style={[cStatS.sub, { color: c.mutedForeground }]}>{sub}</Text>
    </View>
  );
}
const cStatS = StyleSheet.create({
  cell: { flex: 1, minHeight: 130, paddingHorizontal: 28, paddingVertical: 20, justifyContent: 'center', alignItems: 'center', gap: 4, position: 'relative' },
  accentBar: { position: 'absolute', left: 0, top: 24, bottom: 24, width: 4, borderRadius: 2 },
  label: { width: '100%', textAlign: 'center', fontSize: 15, fontFamily: 'Inter_700Bold', letterSpacing: 1.2, lineHeight: 20, textTransform: 'uppercase' },
  value: { ...tekoStyle(64), lineHeight: 72, width: '100%', textAlign: 'center' },
  sub: { width: '100%', textAlign: 'center', fontSize: 14, fontFamily: 'Inter_600SemiBold', letterSpacing: 0.5, lineHeight: 19, textTransform: 'uppercase' },
});

const consoleS = StyleSheet.create({
  dashboard: { width: '100%' },
  grid: { flexDirection: 'column', gap: 16 },
  gridLandscape: { flexDirection: 'row', alignItems: 'stretch', minHeight: 580 },
  col: { gap: 16 },
  statsColLandscape: { flex: 8 },
  statsSectionLandscape: { flex: 1 },
  card: { borderRadius: 12, borderWidth: 1, overflow: 'hidden' },

  identityCard: { flex: 1, padding: 24, minHeight: 340 },
  identityHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4, zIndex: 10 },
  liveIndicator: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  liveDot: { width: 6, height: 6, borderRadius: 3 },
  eyebrow: { fontSize: 10, fontFamily: 'Inter_700Bold', letterSpacing: 1.5 },
  playerName: { ...tekoStyle(52), width: '100%', paddingHorizontal: 4, letterSpacing: 1, marginBottom: 20 },
  actionButtons: { flexDirection: 'row', gap: 8 },
  actionBtn: { width: 44, height: 44, borderRadius: 22, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  shareBtn: { minWidth: 104, height: 44, borderRadius: 22, borderWidth: 1, paddingHorizontal: 16, flexDirection: 'row', gap: 7, alignItems: 'center', justifyContent: 'center' },
  shareBtnText: { fontSize: 10, fontFamily: 'Inter_700Bold', letterSpacing: 0.8 },

  avatarContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 200 },
  avatarWrap: { width: '100%', height: '100%', aspectRatio: 1, maxWidth: 340, maxHeight: 340, borderRadius: 12, borderWidth: 1, overflow: 'hidden' },
  avatar: { width: '100%', height: '100%' },
  avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  avatarInitials: { ...tekoStyle(100), lineHeight: 100, marginTop: 15 },

  shootingCardLandscape: { minHeight: 154, paddingVertical: 28, paddingHorizontal: 12, flexDirection: 'row', justifyContent: 'space-around' },
  sectionTitle: { fontSize: 13, lineHeight: 18, fontFamily: 'Inter_700Bold', letterSpacing: 2, marginBottom: 10, marginLeft: 4 },
  statGrid: { flex: 1 },
  statRow: { flex: 1, minHeight: 130, flexDirection: 'row' },
  vDivider: { width: 1 },
});

// ─── Player Dashboard ─────────────────────────────────────────────────────────
function PlayerDashboard({ player }: { player: any }) {
  const c = useColors();
  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;
  const isTablet = Math.min(width, height) >= 600;
  const isTabletLandscape = isLandscape && Math.min(width, height) >= 600;
  const primaryRgba = (alpha: number) => hexToRgba(c.primary, alpha);

  const { data: summary, isLoading } = useGetPlayerSummary(player.id);
  const updatePlayer = useUpdatePlayer();
  const qc = useQueryClient();
  const { getToken, userId } = useAuth();
  const [uploading, setUploading] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [authToken, setAuthToken] = useState<string | null | undefined>(undefined);
  const [photoLoadFailed, setPhotoLoadFailed] = useState(false);
  const alertVisibleRef = useRef(false);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      getToken()
        .then((t) => { if (!cancelled) setAuthToken(t ?? null); })
        .catch(() => { if (!cancelled) setAuthToken(null); });
      return () => { cancelled = true; };
    }, [getToken]),
  );

  async function handleShareProfile() {
    setSharing(true);
    try {
      const token = await getToken();
      if (!token) throw new Error('Not signed in');
      const res = await fetch(`${API_BASE}/api/players/${player.id}/share-token`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 403) {
        const body = await res.json().catch(() => ({}));
        Alert.alert(
          'Pro Feature',
          body.error ?? 'Shareable player profiles are a Pro feature. Upgrade to share your players.',
          [{ text: 'OK' }],
        );
        return;
      }
      if (!res.ok) throw new Error('Failed to generate share link');
      const { shareToken } = await res.json();
      const domain = process.env.EXPO_PUBLIC_DOMAIN
        ? `https://${process.env.EXPO_PUBLIC_DOMAIN}`
        : 'https://stecstats.com';
      const url = `${domain}/player/${shareToken}`;
      await Share.share({
        message: `Check out ${player.name}'s stats: ${url}`,
        url,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Please try again.';
      Alert.alert('Share failed', msg, [{ text: 'OK' }]);
    } finally {
      setSharing(false);
    }
  }

  useEffect(() => { setPhotoLoadFailed(false); }, [player.photoObjectPath]);

  const MAX_RETRIES = 3;

  async function attemptUpload(asset: ImagePicker.ImagePickerAsset, pendingEntryId?: string, retryCount = 0) {
    setUploading(true);
    try {
      const token = await getToken();
      if (!token) throw new Error('Not signed in — please sign out and back in.');
      const mimeType = asset.mimeType ?? 'image/jpeg';
      const objectPath = await uploadPhoto(asset.uri, mimeType, token);
      await updatePlayer.mutateAsync({ playerId: player.id, data: { photoObjectPath: objectPath } });
      qc.invalidateQueries({ queryKey: getListPlayersQueryKey() });
      if (pendingEntryId && userId) await dequeuePhoto(userId, pendingEntryId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Please try again.';
      const entryId = pendingEntryId ?? (userId
        ? await enqueuePhoto(userId, asset.uri, asset.mimeType ?? 'image/jpeg', player.id)
        : undefined);
      if (alertVisibleRef.current) return;
      alertVisibleRef.current = true;
      if (retryCount >= MAX_RETRIES) {
        Alert.alert('Upload failed', 'Check your connection and try again later.', [
          { text: 'OK', style: 'cancel', onPress: () => { alertVisibleRef.current = false; } },
        ]);
      } else {
        Alert.alert('Upload failed', msg, [
          { text: 'Retry', onPress: () => { alertVisibleRef.current = false; setTimeout(() => attemptUpload(asset, entryId, retryCount + 1), 1000 * Math.pow(2, retryCount)); } },
          { text: 'Cancel', style: 'cancel', onPress: () => { alertVisibleRef.current = false; } },
        ]);
      }
    } finally { setUploading(false); }
  }

  async function handlePhotoTap() {
    Alert.alert('Player Photo', undefined, [
      {
        text: 'Choose from Library',
        onPress: async () => {
          const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
          if (!perm.granted) { Alert.alert('Permission needed', 'Allow photo access in Settings.'); return; }
          const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: 'images', allowsEditing: true, aspect: [1, 1], quality: 0.8 });
          if (result.canceled || !result.assets[0]) return;
          await attemptUpload(result.assets[0]);
        },
      },
      ...(player.photoObjectPath ? [{
        text: 'Remove Photo', style: 'destructive' as const,
        onPress: async () => {
          setUploading(true);
          try { await updatePlayer.mutateAsync({ playerId: player.id, data: { photoObjectPath: null } }); qc.invalidateQueries({ queryKey: getListPlayersQueryKey() }); }
          finally { setUploading(false); }
        },
      }] : []),
      { text: 'Cancel', style: 'cancel' },
    ]);
  }

  if (isLoading || !summary) {
    return <View style={{ paddingVertical: 40, alignItems: 'center' }}><ActivityIndicator color={c.primary} /></View>;
  }

  const fgMade = summary.twoMade + summary.threeMade;
  const fgAtt  = summary.twoAttempted + summary.threeAttempted;
  const winRate = summary.games > 0 ? Math.round((summary.wins / summary.games) * 100) : 0;
  const hasPhoto = !!player.photoObjectPath;

  if (isTablet) {
    return (
      <View testID="tablet-console-dashboard" style={consoleS.dashboard}>
        <View style={[consoleS.grid, isLandscape && consoleS.gridLandscape]}>

          {/* Left Column */}
          <View style={[consoleS.col, isLandscape ? { flex: 4 } : undefined]}>
            <View style={[consoleS.card, consoleS.identityCard, { borderColor: c.border, backgroundColor: c.card }]}>
              <LinearGradient
                pointerEvents="none"
                colors={[primaryRgba(0.08), 'transparent']}
                locations={[0, 0.9]}
                start={{ x: 0, y: 0 }}
                end={{ x: 0.5, y: 1 }}
                style={StyleSheet.absoluteFillObject}
              />
              <View style={consoleS.identityHeader}>
                <View style={consoleS.liveIndicator}>
                  <View style={[consoleS.liveDot, { backgroundColor: c.primary }]} />
                  <Text style={[consoleS.eyebrow, { color: c.primary }]}>
                    {summary.seasonScope === 'career' ? 'CAREER DASHBOARD' : 'SEASON DASHBOARD'}
                  </Text>
                </View>
                <View style={consoleS.actionButtons}>
                  <TouchableOpacity
                    accessibilityLabel="Change player photo"
                    onPress={handlePhotoTap}
                    activeOpacity={0.65}
                    style={[consoleS.actionBtn, { borderColor: c.border, backgroundColor: c.card }]}
                  >
                    {uploading ? <ActivityIndicator size="small" color={c.foreground} /> : <Ionicons name="camera-outline" size={20} color={c.foreground} />}
                  </TouchableOpacity>
                  <TouchableOpacity
                    accessibilityLabel="Share player profile"
                    onPress={handleShareProfile}
                    disabled={sharing}
                    activeOpacity={0.65}
                    style={[consoleS.shareBtn, { borderColor: primaryRgba(0.55), backgroundColor: primaryRgba(0.12) }]}
                  >
                    {sharing ? <ActivityIndicator size="small" color={c.foreground} /> : (
                      <>
                        <Ionicons name="share-outline" size={17} color={c.primary} />
                        <Text style={[consoleS.shareBtnText, { color: c.foreground }]}>SHARE PLAYER</Text>
                      </>
                    )}
                  </TouchableOpacity>
                </View>
              </View>
              <Text
                style={[consoleS.playerName, { color: c.foreground }]}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.72}
              >
                {player.name.toUpperCase()}
              </Text>

              <View style={consoleS.avatarContainer}>
                <View style={[consoleS.avatarWrap, { borderColor: c.border, backgroundColor: primaryRgba(0.04) }]}>
                  {hasPhoto && authToken !== undefined && authToken !== null && !photoLoadFailed ? (
                    <Image
                      source={{ uri: photoSrc(player.photoObjectPath), headers: { Authorization: `Bearer ${authToken}` } }}
                      style={consoleS.avatar}
                      contentFit="cover"
                      onError={() => setPhotoLoadFailed(true)}
                    />
                  ) : (
                    <View style={[consoleS.avatar, consoleS.avatarFallback]}>
                      <Text style={[consoleS.avatarInitials, { color: c.primary }]}>
                        {player.name.split(' ').map((w: string) => w[0]).join('').slice(0, 2).toUpperCase()}
                      </Text>
                    </View>
                  )}
                </View>
              </View>
            </View>

            {isLandscape && (
              <View style={[consoleS.card, consoleS.shootingCardLandscape, { borderColor: c.border, backgroundColor: c.card }]}>
                <ArcGauge pct={fgAtt > 0 ? fgMade / fgAtt : null} label="Field Goal" made={fgMade} attempted={fgAtt} />
                <ArcGauge pct={summary.threeAttempted > 0 ? summary.threeMade / summary.threeAttempted : null} label="3-Point" made={summary.threeMade} attempted={summary.threeAttempted} />
                <ArcGauge pct={summary.ftAttempted > 0 ? summary.ftMade / summary.ftAttempted : null} label="Free Throw" made={summary.ftMade} attempted={summary.ftAttempted} />
              </View>
            )}
          </View>

          {/* Right Column */}
          <View style={[consoleS.col, isLandscape && consoleS.statsColLandscape]}>
            <View style={isLandscape ? consoleS.statsSectionLandscape : undefined}>
              <Text style={[consoleS.sectionTitle, { color: c.mutedForeground }]}>HEADLINE PRODUCTION</Text>
              <View style={[consoleS.card, consoleS.statGrid, { borderColor: c.border, backgroundColor: c.card }]}>
                <View style={[consoleS.statRow, { borderBottomWidth: 1, borderBottomColor: c.border }]}>
                  <ConsoleStat label="Points / GM" value={summary.ppg.toFixed(1)} sub={`${summary.points} TOTAL`} accent />
                  <View style={[consoleS.vDivider, { backgroundColor: c.border }]} />
                  <ConsoleStat label="Rebounds / GM" value={summary.rpg.toFixed(1)} sub={`${summary.rebounds} TOTAL`} />
                </View>
                <View style={consoleS.statRow}>
                  <ConsoleStat label="Games Played" value={String(summary.games)} sub={`${summary.wins}W · ${summary.losses}L`} />
                  <View style={[consoleS.vDivider, { backgroundColor: c.border }]} />
                  <ConsoleStat label="Win Record" value={`${winRate}%`} sub={`${summary.wins}-${summary.losses} OVERALL`} />
                </View>
              </View>
            </View>

            <View style={isLandscape ? consoleS.statsSectionLandscape : undefined}>
              <Text style={[consoleS.sectionTitle, { color: c.mutedForeground, marginTop: 12 }]}>PLAYMAKING & DEFENSE</Text>
              <View style={[consoleS.card, consoleS.statGrid, { borderColor: c.border, backgroundColor: c.card }]}>
                <View style={[consoleS.statRow, { borderBottomWidth: 1, borderBottomColor: c.border }]}>
                  <ConsoleStat label="Assists / GM" value={summary.apg.toFixed(1)} sub={`${summary.assists} TOTAL`} />
                  <View style={[consoleS.vDivider, { backgroundColor: c.border }]} />
                  <ConsoleStat label="Turnovers / GM" value={summary.topg.toFixed(1)} sub={`${summary.turnovers} TOTAL`} />
                </View>
                <View style={consoleS.statRow}>
                  <ConsoleStat label="Steals / GM" value={summary.spg.toFixed(1)} sub={`${summary.steals} TOTAL`} />
                  <View style={[consoleS.vDivider, { backgroundColor: c.border }]} />
                  <ConsoleStat label="Blocks / GM" value={summary.bpg.toFixed(1)} sub={`${summary.blocks} TOTAL`} />
                </View>
              </View>
            </View>

            {!isLandscape && (
              <View>
                <Text style={[consoleS.sectionTitle, { color: c.mutedForeground, marginTop: 12 }]}>SHOOTING EFFICIENCY</Text>
                <View style={[consoleS.card, { borderColor: c.border, backgroundColor: c.card, paddingVertical: 28, paddingHorizontal: 12, flexDirection: 'row', justifyContent: 'space-around' }]}>
                  <ArcGauge pct={fgAtt > 0 ? fgMade / fgAtt : null} label="Field Goal" made={fgMade} attempted={fgAtt} />
                  <ArcGauge pct={summary.threeAttempted > 0 ? summary.threeMade / summary.threeAttempted : null} label="3-Point" made={summary.threeMade} attempted={summary.threeAttempted} />
                  <ArcGauge pct={summary.ftAttempted > 0 ? summary.ftMade / summary.ftAttempted : null} label="Free Throw" made={summary.ftMade} attempted={summary.ftAttempted} />
                </View>
              </View>
            )}
          </View>

        </View>
        <View style={{ height: 40 }} />
      </View>
    );
  }

  // ── Integrated Player Panel (Desktop Style) ───────────────────────────────
  const heroCard = (
    <View style={[
      heroS.container, 
      { borderColor: primaryRgba(0.8), backgroundColor: c.card },
      isLandscape && heroS.containerLandscape,
      isTabletLandscape && heroS.cardWrapperTabletLandscape,
    ]}>
      <LinearGradient
        pointerEvents="none"
        colors={[primaryRgba(0.3), primaryRgba(0.1), 'transparent']}
        locations={[0, 0.58, 1]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFillObject}
      />
      <BasketballWatermark color={c.primary} />
      <View style={heroS.topRow}>
        <View style={heroS.playerInfo}>
          {hasPhoto && authToken !== undefined && authToken !== null && !photoLoadFailed ? (
            <Image
              source={{ uri: photoSrc(player.photoObjectPath), headers: { Authorization: `Bearer ${authToken}` } }}
              style={heroS.avatar}
              contentFit="cover"
              onError={() => setPhotoLoadFailed(true)}
            />
          ) : (
            <View style={[heroS.avatar, { backgroundColor: c.border }]}>
              <Text style={[heroS.avatarInitials, { color: c.mutedForeground }]}>
                {player.name.split(' ').map((w: string) => w[0]).join('').slice(0, 2).toUpperCase()}
              </Text>
            </View>
          )}
          <View style={heroS.nameCol}>
            <Text style={[heroS.eyebrow, { color: c.primary }]}>PLAYER PROFILE</Text>
            <Text style={[heroS.name, { color: c.foreground }]}>{player.name.toUpperCase()}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <View style={[heroS.scopePill, { backgroundColor: c.primary }]}>
                <Text style={[heroS.scopeText, { color: c.primaryForeground }]}>
                  {summary.seasonScope === 'career' ? 'CAREER' : 'SEASON'}
                </Text>
              </View>
              <Text style={{ fontSize: 10, fontFamily: 'Inter_600SemiBold', color: c.mutedForeground, letterSpacing: 0.5 }}>OVERVIEW</Text>
            </View>
          </View>
        </View>

        <View style={heroS.actionRow}>
          <TouchableOpacity onPress={handlePhotoTap} style={[heroS.iconBtn, { borderColor: c.border }]}>
            <BlurView tint="dark" intensity={45} style={StyleSheet.absoluteFillObject} />
            {uploading ? <ActivityIndicator size="small" color={c.foreground} /> : <Ionicons name="camera-outline" size={18} color={c.foreground} />}
          </TouchableOpacity>
          <TouchableOpacity onPress={handleShareProfile} disabled={sharing} style={[heroS.iconBtn, { borderColor: c.border }]}>
            <BlurView tint="dark" intensity={45} style={StyleSheet.absoluteFillObject} />
            {sharing ? <ActivityIndicator size="small" color={c.foreground} /> : <Ionicons name="share-outline" size={18} color={c.foreground} />}
          </TouchableOpacity>
        </View>
      </View>
      {/* Decorative top border for the stats block instead of a thick divider, matching desktop panels */}
      <View style={[heroS.divider, { backgroundColor: c.primary }]} />
    </View>
  );

  // ── Stats column content ────────────────────────────────────────────
  const statsColumn = (
    <>
      <SectionHeader title="Performance" />
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
        <StatCard label="Points / GM" value={summary.ppg.toFixed(1)} sub={`${summary.points} TOTAL`} />
        <StatCard label="Games" value={String(summary.games)} sub={`${summary.wins}W · ${summary.losses}L`} />
      </View>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <StatCard label="Win Rate" value={`${winRate}%`} sub={`${summary.wins}–${summary.losses}`} />
        <StatCard label="Rebounds / GM" value={summary.rpg.toFixed(1)} sub={`${summary.rebounds} TOTAL`} />
      </View>

      <SectionHeader title="Shooting Efficiency" />
      {isLandscape ? (
        <CompactShootingStrip
          fgMade={fgMade} fgAtt={fgAtt}
          threeMade={summary.threeMade} threeAtt={summary.threeAttempted}
          ftMade={summary.ftMade} ftAtt={summary.ftAttempted}
        />
      ) : (
        <View style={[shootS.card, { borderColor: c.border, backgroundColor: c.card }]}>
          <ArcGauge pct={fgAtt > 0 ? fgMade / fgAtt : null} label="Field Goal" made={fgMade} attempted={fgAtt} />
          <View style={[shootS.divider, { backgroundColor: c.border }]} />
          <ArcGauge pct={summary.threeAttempted > 0 ? summary.threeMade / summary.threeAttempted : null} label="3-Point" made={summary.threeMade} attempted={summary.threeAttempted} />
          <View style={[shootS.divider, { backgroundColor: c.border }]} />
          <ArcGauge pct={summary.ftAttempted > 0 ? summary.ftMade / summary.ftAttempted : null} label="Free Throw" made={summary.ftMade} attempted={summary.ftAttempted} />
        </View>
      )}

      <SectionHeader title="Playmaking & Defense" />
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
        <StatCard label="Assists / GM" value={summary.apg.toFixed(1)} sub={`${summary.assists} TOTAL`} />
        <StatCard label="Steals / GM"  value={summary.spg.toFixed(1)} sub={`${summary.steals} TOTAL`}  />
      </View>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <StatCard label="Blocks / GM"   value={summary.bpg.toFixed(1)}  sub={`${summary.blocks} TOTAL`}    />
        <StatCard label="Turnovers / GM" value={summary.topg.toFixed(1)} sub={`${summary.turnovers} TOTAL`} />
      </View>
      <View style={{ height: 40 }} />
    </>
  );

  if (isLandscape) {
    const heroWidth = isTabletLandscape
      ? Math.min(400, Math.max(340, Math.round(width * 0.36)))
      : Math.round(width * 0.44) - 20;
    return (
      <View style={[lsS.row, isTabletLandscape && lsS.rowTablet]}>
        <View style={[lsS.heroCol, isTabletLandscape && lsS.heroColTablet, { width: heroWidth }]}>
          {heroCard}
        </View>
        <View style={lsS.statsCol}>
          {statsColumn}
        </View>
      </View>
    );
  }

  return (
    <>
      {heroCard}
      {statsColumn}
    </>
  );
}

const heroS = StyleSheet.create({
  container: {
    minHeight: 148,
    borderRadius: 6,
    borderWidth: 1,
    overflow: 'hidden',
  },
  containerLandscape: {
    marginBottom: 0,
  },
  cardWrapperTabletLandscape: { // Add for tests
    alignSelf: 'flex-start',
  },
  topRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 20,
  },
  playerInfo: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  avatar: {
    width: 78,
    height: 78,
    borderRadius: 39,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.25)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitials: {
    fontSize: 23,
    fontFamily: 'Inter_700Bold',
  },
  nameCol: {
    flex: 1,
    gap: 5,
  },
  eyebrow: {
    fontSize: 8,
    fontFamily: 'Inter_700Bold',
    letterSpacing: 2,
  },
  name: {
    ...tekoStyle(36),
    letterSpacing: 1,
  },
  scopePill: {
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 4,
  },
  scopeText: {
    fontSize: 8,
    fontFamily: 'Inter_700Bold',
    letterSpacing: 0.5,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 6,
  },
  iconBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    backgroundColor: 'rgba(255,255,255,0.08)',
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  divider: {
    height: 3,
    width: '100%',
  },
});

const lsS = StyleSheet.create({
  row: { flexDirection: 'row', gap: 16, alignItems: 'flex-start' },
  rowTablet: { alignItems: 'flex-start', width: '100%' },
  heroCol: { flexShrink: 0 },
  heroColTablet: { alignSelf: 'stretch' },
  statsCol: { flex: 1 },
});

const shootS = StyleSheet.create({
  card:    { flexDirection: 'row', alignItems: 'center', borderRadius: 6, borderWidth: 1, paddingVertical: 20, paddingHorizontal: 10 },
  divider: { width: 1, alignSelf: 'stretch', marginHorizontal: 4 },
});

// ─── Coach greeting header ────────────────────────────────────────────────────
function CoachGreeting() {
  const c = useColors();
  const { user } = useUser();
  const { isLoaded, isSignedIn } = useAuth();
  const { data: meData } = useGetMe({ query: { enabled: isLoaded && !!isSignedIn, refetchOnMount: 'always' } as any });

  const hour = new Date().getHours();
  const salutation = hour < 12 ? 'Morning' : hour < 17 ? 'Afternoon' : 'Evening';
  const firstName = meData?.firstName ?? 'Coach';
  const initials = firstName.slice(0, 1).toUpperCase();

  return (
    <View style={greetS.row}>
      {user?.imageUrl ? (
        <Image source={{ uri: user.imageUrl }} style={greetS.avatar} contentFit="cover" />
      ) : (
        <View style={[greetS.avatar, greetS.avatarFallback, { backgroundColor: c.primary + '30', borderColor: c.primary + '50' }]}>
          <Text style={[greetS.initials, { color: c.primary }]}>{initials}</Text>
        </View>
      )}
      <View style={greetS.textCol}>
        <Text style={[greetS.salutation, { color: c.mutedForeground }]}>{salutation.toUpperCase()}</Text>
        <Text style={[greetS.name, { color: c.foreground }]} numberOfLines={1}>{firstName}</Text>
      </View>
    </View>
  );
}

const greetS = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 20, marginTop: 4 },
  avatar: { width: 44, height: 44, borderRadius: 22, borderWidth: 2 },
  avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  initials: { fontSize: 18, fontFamily: 'Inter_700Bold' },
  textCol: { gap: 2 },
  salutation: { fontSize: 10, fontFamily: 'Inter_600SemiBold', letterSpacing: 1.5 },
  name: { fontSize: 24, fontFamily: 'Inter_700Bold', letterSpacing: 0.2 },
});

// ─── Main Screen ──────────────────────────────────────────────────────────────
export default function DashboardScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { width: screenW, height: screenH } = useWindowDimensions();
  const isTablet = screenW >= 768;
  const router = useRouter();

  const { data: players, isLoading, refetch } = useListPlayers();
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const activeId = selectedId ?? (players?.[0] as any)?.id ?? null;
  const activePlayer = (players as any[])?.find((p) => p.id === activeId) ?? null;

  if (isLoading) {
    return (
      <View style={[styles.root, styles.centered, { backgroundColor: c.background }]}>
        <ActivityIndicator color={c.primary} />
      </View>
    );
  }

  if (!players?.length) {
    return (
      <View style={[styles.root, styles.centered, { backgroundColor: c.background }]}>
        <Ionicons name="basketball-outline" size={52} color={c.border} />
        <Text style={[styles.emptyTitle, { color: c.foreground }]}>No players yet</Text>
        <Text style={[styles.emptySub, { color: c.mutedForeground }]}>Add your roster to start tracking stats.</Text>
        <TouchableOpacity
          onPress={() => router.push('/roster')}
          activeOpacity={0.8}
          style={[styles.emptyBtn, { backgroundColor: c.primary }]}
        >
          <Ionicons name="person-add-outline" size={16} color={c.primaryForeground} />
          <Text style={[styles.emptyBtnText, { color: c.primaryForeground }]}>Add Players</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const chipBar = (
    <ScrollView
      horizontal
      style={styles.chipScroller}
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.chips}
    >
      {(players as any[]).map((p) => (
        <PlayerChip key={p.id} player={p} isSelected={p.id === activeId} onPress={() => setSelectedId(p.id)} />
      ))}
    </ScrollView>
  );

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      <ScreenGlow primary={c.primary} />
      <BasketballWatermark color={c.primary} />
      <StatsWatermark color={c.primary} />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={[
          styles.content,
          {
            paddingTop: insets.top + (Platform.OS === 'web' ? 67 : Platform.OS === 'ios' ? 16 : 24),
            paddingBottom: insets.bottom + 100,
            paddingLeft: (isTablet ? 6 : 16) + (insets.left ?? 0),
            paddingRight: (isTablet ? 6 : 16) + (insets.right ?? 0),
          },
        ]}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={false} onRefresh={refetch} tintColor={c.primary} />}
      >
        <View style={[styles.dashboardHeader, isTablet && styles.dashboardHeaderTablet]}>
          <CoachGreeting />
        </View>

        <View style={styles.playerSelector}>
          <View style={[styles.playerSelectorBar, { backgroundColor: c.primary }]} />
          <Text style={[styles.playerSelectorLabel, { color: c.foreground }]}>ROSTER</Text>
          {chipBar}
        </View>

        {activePlayer
          ? <PlayerDashboard player={activePlayer} />
          : <View style={styles.centered}><ActivityIndicator color={c.primary} /></View>}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root:    { flex: 1 },
  centered:{ flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: {},
  chipScroller: { flex: 1 },
  chips: { paddingRight: 16 },
  dashboardHeader: { alignSelf: 'stretch', marginBottom: 12, gap: 12 },
  dashboardHeaderTablet: { minHeight: 68, flexDirection: 'row', alignItems: 'center' },
  
  playerSelector: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 24,
  },
  playerSelectorBar: {
    width: 3,
    height: 16,
    borderRadius: 2,
    marginRight: 8,
  },
  playerSelectorLabel: {
    fontSize: 14,
    fontFamily: 'Inter_700Bold',
    letterSpacing: 1.5,
    marginRight: 16,
  },
  
  emptyTitle: { fontSize: 20, fontFamily: 'Inter_700Bold', marginTop: 16, marginBottom: 8 },
  emptySub:   { fontSize: 14, textAlign: 'center', maxWidth: 260, fontFamily: 'Inter_400Regular', lineHeight: 20 },
  emptyBtn:   { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 24, paddingHorizontal: 24, paddingVertical: 13, borderRadius: 14 },
  emptyBtnText: { fontSize: 15, fontFamily: 'Inter_700Bold' },
});
