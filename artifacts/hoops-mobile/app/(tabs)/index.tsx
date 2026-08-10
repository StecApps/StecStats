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
import { enqueuePhoto, dequeuePhoto } from '@/lib/pendingPhotoQueue';
import { uploadPhoto, API_BASE } from '@/lib/photoUpload';
import Svg, { Circle, G, Path, Rect } from 'react-native-svg';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import { useAuth, useUser } from '@clerk/clerk-expo';
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

// ─── Theme helpers ────────────────────────────────────────────────────────────
// Derive rgba strings from the design-token palette so a single change to
// colors.ts flows through to every opacity variant used below.
function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function photoSrc(objectPath: string) {
  return `${API_BASE}/api/storage/objects/${objectPath.replace(/^\/objects\//, '')}`;
}

// ─── Screen-level background layers ──────────────────────────────────────────

// Deep orange sunburst from the top of the screen — bleeds down ~55% of height.
function ScreenGlow({ primary }: { primary: string }) {
  const r = (a: number) => hexToRgba(primary, a);
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFillObject}>
      {/* Central radial cone — bright at crown, gone by mid-screen */}
      <LinearGradient
        colors={[r(0.38), r(0.18), r(0.06), r(0)]}
        locations={[0, 0.22, 0.45, 0.70]}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
        style={StyleSheet.absoluteFillObject}
      />
      {/* Slight left-lean so the glow hugs the basketball watermark */}
      <LinearGradient
        colors={[r(0.14), r(0)]}
        locations={[0, 0.5]}
        start={{ x: 0.75, y: 0 }}
        end={{ x: 0.25, y: 0.5 }}
        style={StyleSheet.absoluteFillObject}
      />
    </View>
  );
}

// Large basketball seam drawing, clipped into the top-right corner.
function BasketballWatermark({ color }: { color: string }) {
  const S = 340, CX = S / 2, CY = S / 2, R = 155, SW = 9;
  return (
    <View
      pointerEvents="none"
      style={{ position: 'absolute', top: -60, right: -100, width: S, height: S, opacity: 0.11 }}
    >
      <Svg width={S} height={S}>
        {/* Outer circle */}
        <Circle cx={CX} cy={CY} r={R} stroke={color} strokeWidth={SW} fill="none" />
        {/* Vertical S-seam through centre */}
        <Path
          d={`M${CX},${CY - R} C${CX - 62},${CY - R * 0.38} ${CX + 62},${CY + R * 0.38} ${CX},${CY + R}`}
          stroke={color} strokeWidth={SW} fill="none" strokeLinecap="round"
        />
        {/* Upper horizontal seam */}
        <Path
          d={`M${CX - R},${CY} Q${CX},${CY - R * 0.68} ${CX + R},${CY}`}
          stroke={color} strokeWidth={SW} fill="none" strokeLinecap="round"
        />
        {/* Lower horizontal seam */}
        <Path
          d={`M${CX - R},${CY} Q${CX},${CY + R * 0.68} ${CX + R},${CY}`}
          stroke={color} strokeWidth={SW} fill="none" strokeLinecap="round"
        />
      </Svg>
    </View>
  );
}

// Tiny bar-chart ghost — floats behind the shooting efficiency card.
function StatsWatermark({ color }: { color: string }) {
  const W = 180, H = 140;
  const bars: [number, number][] = [[0.50, 0], [0.78, 1], [0.40, 2], [0.92, 3], [0.65, 4]];
  const barW = 26, gap = 12, maxH = 100, baseY = 120;
  return (
    <View
      pointerEvents="none"
      style={{ position: 'absolute', bottom: 120, right: -10, width: W, height: H, opacity: 0.055 }}
    >
      <Svg width={W} height={H}>
        {bars.map(([h, i]) => {
          const bH = h * maxH;
          return (
            <Rect key={i} x={10 + i * (barW + gap)} y={baseY - bH} width={barW} height={bH} rx={5} fill={color} />
          );
        })}
      </Svg>
    </View>
  );
}

// Basketball hoop (backboard + rim + net) — floats on the left side of the hero card.
function HoopWatermark({ color }: { color: string }) {
  const W = 170, H = 165, SW = 7;
  const bbX = 48, bbY = 10, bbW = 74, bbH = 50;
  const rimY = bbY + bbH;
  const rimL = 8, rimR = 152;
  const netBot = 152;
  // 7 vertical net lines fanning from the full rim width down to a narrower mouth
  const netLines = Array.from({ length: 7 }, (_, i) => {
    const t = i / 6;
    const tx = rimL + t * (rimR - rimL);
    const bx = 42 + t * 86;
    return `M${tx},${rimY + 6} L${bx},${netBot}`;
  });
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: -38, top: 14, width: W, height: H, opacity: 0.11 }}>
      <Svg width={W} height={H}>
        {/* Backboard */}
        <Rect x={bbX} y={bbY} width={bbW} height={bbH} rx={4} fill="none" stroke={color} strokeWidth={SW} />
        {/* Inner target square */}
        <Rect x={bbX + 13} y={bbY + 12} width={bbW - 26} height={bbH - 24} rx={2} fill="none" stroke={color} strokeWidth={SW * 0.55} />
        {/* Rim */}
        <Path d={`M${rimL},${rimY} H${rimR}`} stroke={color} strokeWidth={SW} strokeLinecap="round" />
        {/* Net lines */}
        {netLines.map((d, i) => <Path key={i} d={d} stroke={color} strokeWidth={SW * 0.5} strokeLinecap="round" />)}
        {/* Net bottom */}
        <Path d={`M42,${netBot} H128`} stroke={color} strokeWidth={SW * 0.5} strokeLinecap="round" />
      </Svg>
    </View>
  );
}

// ─── Glass glare components ──────────────────────────────────────────────────

// A clean white sheen at the top of a card — like light catching glass.
function Gloss() {
  return (
    <View style={StyleSheet.absoluteFillObject} pointerEvents="none">
      {/* Very subtle white wash from top */}
      <LinearGradient
        colors={['rgba(255,255,255,0.07)', 'rgba(255,255,255,0.0)']}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 0.6 }}
        style={{ ...StyleSheet.absoluteFillObject }}
      />
      {/* Specular highlight — bright narrow pill at very top */}
      <LinearGradient
        colors={['rgba(255,255,255,0.45)', 'rgba(255,255,255,0.0)']}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
        style={{
          position: 'absolute',
          top: 0,
          left: '22%',
          right: '22%',
          height: 14,
          borderBottomLeftRadius: 999,
          borderBottomRightRadius: 999,
        }}
      />
    </View>
  );
}

// Orange glow from the top edge — only used on the hero card.
function OrangeGlow({ primary, strength = 1 }: { primary: string; strength?: number }) {
  const rgba = (a: number) => hexToRgba(primary, a);
  return (
    <View style={StyleSheet.absoluteFillObject} pointerEvents="none">
      <LinearGradient
        colors={[
          rgba(0.30 * strength),
          rgba(0.10 * strength),
          rgba(0),
        ]}
        locations={[0, 0.35, 1]}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
        style={{ flex: 1 }}
      />
    </View>
  );
}

// White neutral glare for selected chips
function GlareOverlay({ intensity = 0.15 }: { intensity?: number }) {
  return (
    <View style={StyleSheet.absoluteFillObject} pointerEvents="none">
      <LinearGradient
        colors={[`rgba(255,255,255,${intensity})`, 'rgba(255,255,255,0.0)']}
        start={{ x: 0.15, y: 0 }}
        end={{ x: 0.85, y: 0.75 }}
        style={{ flex: 1 }}
      />
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
  const SIZE = 130, SW = 10;
  const r = (SIZE - SW) / 2;
  const circ = 2 * Math.PI * r;
  const filled = Math.max(0, Math.min(1, pct ?? 0)) * circ;
  const pctStr = pct != null && pct > 0 ? `${(pct * 100).toFixed(1)}%` : '—';

  return (
    <View style={gaugeS.wrap}>
      <View style={{ width: SIZE, height: SIZE }}>
        <Svg width={SIZE} height={SIZE}>
          <G rotation="-90" origin={`${SIZE / 2},${SIZE / 2}`}>
            {/* Track uses the border token so it's readable in both themes */}
            <Circle cx={SIZE/2} cy={SIZE/2} r={r}
              stroke={c.border} strokeWidth={SW} fill="none" />
            <Circle cx={SIZE/2} cy={SIZE/2} r={r}
              stroke={c.primary} strokeWidth={SW} fill="none"
              strokeDasharray={`${filled} ${circ}`} strokeLinecap="round" />
          </G>
        </Svg>
        <View style={gaugeS.center}>
          {/* Percentage lives inside the card — use cardForeground */}
          <Text style={[gaugeS.pctNum, { color: c.cardForeground }]}>{pctStr}</Text>
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
  pctNum:   { ...tekoStyle(30) },
  madeFrac: { fontSize: 10, fontFamily: 'Inter_400Regular', marginTop: 1 },
  label:    { fontSize: 10, fontFamily: 'Inter_600SemiBold', letterSpacing: 1, marginTop: 8 },
});

// ─── Player chip ─────────────────────────────────────────────────────────────
function PlayerChip({ player, isSelected, onPress }: { player: any; isSelected: boolean; onPress: () => void }) {
  const c = useColors();
  const { data: summary } = useGetPlayerSummary(player.id);
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.75}
      style={[
        chipS.chip,
        {
          backgroundColor: isSelected ? c.primary : c.card,
          borderColor: isSelected ? c.primary : c.border,
          overflow: 'hidden',
        },
      ]}
    >
      {isSelected && <GlareOverlay intensity={0.18} />}
      {/* When selected: white text on primary bg. When unselected: card text on card bg. */}
      <Text style={[chipS.name, { color: isSelected ? c.primaryForeground : c.cardForeground }]}>{player.name}</Text>
      <Text style={[chipS.sub, { color: isSelected ? 'rgba(255,255,255,0.75)' : c.mutedForeground }]}>
        {summary ? `${summary.games}GP · ${summary.ppg.toFixed(1)}PPG` : '…'}
      </Text>
    </TouchableOpacity>
  );
}
const chipS = StyleSheet.create({
  chip: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 24, borderWidth: 1, marginRight: 8, minWidth: 110 },
  name: { fontSize: 14, fontFamily: 'Inter_700Bold' },
  sub:  { fontSize: 11, fontFamily: 'Inter_400Regular', marginTop: 2 },
});

// ─── Big stat card ────────────────────────────────────────────────────────────
function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  const c = useColors();
  return (
    <View style={[statS.card, { overflow: 'hidden', borderColor: c.border, backgroundColor: c.card }]}>
      <Gloss />
      <Text style={[statS.label, { color: c.mutedForeground }]}>{label}</Text>
      <Text style={[statS.value, { color: c.primary }]}>{value}</Text>
      {sub && <Text style={[statS.sub, { color: c.mutedForeground }]}>{sub}</Text>}
    </View>
  );
}
const statS = StyleSheet.create({
  card:  { flex: 1, borderRadius: 16, borderWidth: 1, padding: 16, alignItems: 'center' },
  label: { fontSize: 9, fontFamily: 'Inter_600SemiBold', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 6, textAlign: 'center' },
  value: { ...tekoStyle(46) },
  sub:   { fontSize: 10, fontFamily: 'Inter_400Regular', marginTop: 2, textAlign: 'center' },
});

// ─── Mini stat (playmaking / defense) ────────────────────────────────────────
function MiniStat({ label, value, total }: { label: string; value: string; total?: string }) {
  const c = useColors();
  return (
    <View style={[miniS.wrap, { overflow: 'hidden', borderColor: c.border, backgroundColor: c.card }]}>
      <Gloss />
      <Text style={[miniS.label, { color: c.mutedForeground }]}>{label}</Text>
      {/* Large value uses cardForeground so it reads on both light and dark cards */}
      <Text style={[miniS.value, { color: c.cardForeground }]}>{value}</Text>
      {total && <Text style={[miniS.total, { color: c.mutedForeground }]}>{total} TOT</Text>}
    </View>
  );
}
const miniS = StyleSheet.create({
  wrap:  { flex: 1, borderRadius: 14, borderWidth: 1, padding: 14, alignItems: 'center' },
  label: { fontSize: 9, fontFamily: 'Inter_600SemiBold', letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: 4, textAlign: 'center' },
  value: { ...tekoStyle(36) },
  total: { fontSize: 9, fontFamily: 'Inter_400Regular', marginTop: 2 },
});

// ─── Section header ───────────────────────────────────────────────────────────
function SectionHeader({ title }: { title: string }) {
  const c = useColors();
  return (
    <View style={secS.row}>
      <View style={[secS.dot, { backgroundColor: c.primary }]} />
      <Text style={[secS.title, { color: c.foreground }]}>{title.toUpperCase()}</Text>
      <View style={{ flex: 1, height: 1, backgroundColor: c.border, marginLeft: 10, alignSelf: 'center' }} />
    </View>
  );
}
const secS = StyleSheet.create({
  row:   { flexDirection: 'row', alignItems: 'center', marginBottom: 12, marginTop: 24 },
  dot:   { width: 6, height: 6, borderRadius: 3, marginRight: 8 },
  title: { ...tekoStyle(20), letterSpacing: 2 },
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
    <View style={[cShootS.row, { borderColor: c.border, backgroundColor: c.card, overflow: 'hidden' }]}>
      <Gloss />
      {cells.map((cell, i) => (
        <React.Fragment key={cell.label}>
          <View style={cShootS.cell}>
            <Text style={[cShootS.label, { color: c.mutedForeground }]}>{cell.label}</Text>
            <Text style={[cShootS.value, { color: c.primary }]}>{cell.val}</Text>
            <Text style={[cShootS.frac, { color: c.mutedForeground }]}>{cell.frac}</Text>
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
  row:     { flexDirection: 'row', borderRadius: 14, borderWidth: 1, padding: 12, alignItems: 'center' },
  cell:    { flex: 1, alignItems: 'center', gap: 2 },
  label:   { fontSize: 9, fontFamily: 'Inter_600SemiBold', letterSpacing: 1, textTransform: 'uppercase' },
  value:   { ...tekoStyle(28) },
  frac:    { fontSize: 9, fontFamily: 'Inter_400Regular' },
  divider: { width: 1, alignSelf: 'stretch', marginHorizontal: 6 },
});

// ─── Player Dashboard ─────────────────────────────────────────────────────────
function PlayerDashboard({ player }: { player: any }) {
  const c = useColors();
  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;
  // Local rgba helper keyed to the current palette's primary color
  const primaryRgba = (alpha: number) => hexToRgba(c.primary, alpha);

  const { data: summary, isLoading } = useGetPlayerSummary(player.id);
  const updatePlayer = useUpdatePlayer();
  const qc = useQueryClient();
  const { getToken, userId } = useAuth();
  const [uploading, setUploading] = useState(false);
  const [sharing, setSharing] = useState(false);
  // undefined = still fetching; string = token ready; null = unavailable
  const [authToken, setAuthToken] = useState<string | null | undefined>(undefined);
  const [photoLoadFailed, setPhotoLoadFailed] = useState(false);
  const alertVisibleRef = useRef(false);

  // Re-fetch the token whenever the screen comes into focus (handles expiry/refocus)
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

  // ── Shared hero card content ──────────────────────────────────────────────
  const heroCard = (
    <View style={[heroS.cardWrapper, { shadowColor: c.primary }, isLandscape && heroS.cardWrapperLandscape]}>
      <View style={[heroS.card, { borderColor: primaryRgba(0.65), backgroundColor: c.card }, isLandscape && heroS.cardLandscape]}>
        {/* Orange glow radiates from the top edge of the hero card */}
        <OrangeGlow primary={c.primary} strength={2.2} />
        {/* Deep ambient fill — bottom half of card glows darker orange */}
        <LinearGradient
          colors={[primaryRgba(0), primaryRgba(0.10)]}
          start={{ x: 0.5, y: 0.3 }} end={{ x: 0.5, y: 1 }}
          style={StyleSheet.absoluteFillObject}
          pointerEvents="none"
        />
        {/* Top orange accent bar — wider fade */}
        <LinearGradient
          colors={[c.primary, primaryRgba(0.4), primaryRgba(0)]}
          locations={[0, 0.5, 1]}
          start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
          style={heroS.topBar}
        />
        {/* Glass sheen */}
        <View style={StyleSheet.absoluteFillObject} pointerEvents="none">
          <LinearGradient
            colors={['rgba(255,255,255,0.07)', 'rgba(255,255,255,0)']}
            start={{ x: 0, y: 0 }} end={{ x: 0, y: 0.45 }}
            style={{ flex: 1 }}
          />
        </View>

        {/* Hoop watermark — left side, clipped by overflow:hidden */}
        <HoopWatermark color={c.primary} />

        {/* Basketball watermark inside the hero card — clipped by overflow:hidden */}
        <View pointerEvents="none" style={{ position: 'absolute', right: -55, bottom: -38, width: 220, height: 220, opacity: 0.13 }}>
          <Svg width={220} height={220}>
            <Circle cx={110} cy={110} r={100} stroke={c.primary} strokeWidth={7} fill="none" />
            <Path
              d="M110,10 C68,45 152,175 110,210"
              stroke={c.primary} strokeWidth={7} fill="none" strokeLinecap="round"
            />
            <Path
              d="M10,110 Q110,43 210,110"
              stroke={c.primary} strokeWidth={7} fill="none" strokeLinecap="round"
            />
            <Path
              d="M10,110 Q110,177 210,110"
              stroke={c.primary} strokeWidth={7} fill="none" strokeLinecap="round"
            />
          </Svg>
        </View>

        {/* Live badge */}
        <View style={heroS.liveBadge}>
          <Ionicons name="flash" size={11} color={c.primary} />
          <Text style={[heroS.liveText, { color: c.primary }]}>LIVE STATS</Text>
          <Ionicons name="flash" size={11} color={c.primary} />
        </View>

        {/* Avatar */}
        <TouchableOpacity onPress={handlePhotoTap} activeOpacity={0.85} style={heroS.avatarOuter}>
          {/* Orange glow ring behind avatar */}
          <View style={[heroS.avatarGlow, { backgroundColor: primaryRgba(0.18), shadowColor: c.primary }]} />
          <View style={[
            heroS.avatarRing,
            { borderColor: c.primary, backgroundColor: primaryRgba(0.12) },
            isLandscape && heroS.avatarRingLandscape,
          ]}>
            {hasPhoto && authToken !== undefined && authToken !== null && !photoLoadFailed ? (
              <Image
                source={{ uri: photoSrc(player.photoObjectPath), headers: { Authorization: `Bearer ${authToken}` } }}
                style={heroS.avatarImg}
                contentFit="cover"
                onError={() => setPhotoLoadFailed(true)}
              />
            ) : (
              <View style={heroS.avatarFallback}>
                <Text style={[heroS.avatarInitials, { color: c.primary }, isLandscape && heroS.avatarInitialsLandscape]}>
                  {player.name.split(' ').map((w: string) => w[0]).join('').slice(0, 2).toUpperCase()}
                </Text>
              </View>
            )}
            {/* Diagonal glass shine over photo */}
            <View style={StyleSheet.absoluteFillObject} pointerEvents="none">
              <LinearGradient
                colors={['rgba(255,255,255,0.30)', 'rgba(255,255,255,0.0)']}
                start={{ x: 0.1, y: 0 }} end={{ x: 0.85, y: 0.55 }}
                style={{ flex: 1 }}
              />
            </View>
          </View>
          {/* Camera badge */}
          <View style={[heroS.cameraBadge, { backgroundColor: c.primary, borderColor: c.background }]}>
            {uploading ? <ActivityIndicator size="small" color={c.primaryForeground} /> : <Ionicons name="camera" size={12} color={c.primaryForeground} />}
          </View>
        </TouchableOpacity>

        {/* Name — lives on the card background, use cardForeground */}
        <Text style={[heroS.name, { color: c.cardForeground }, isLandscape && heroS.nameLandscape]}>{player.name.toUpperCase()}</Text>

        {/* Season scope pill */}
        <View style={[heroS.scopePill, { borderColor: c.border, backgroundColor: c.muted }]}>
          <Text style={[heroS.scopeText, { color: c.mutedForeground }]}>
            {summary.seasonScope === 'career' ? 'CAREER' : 'SEASON'} OVERVIEW
          </Text>
        </View>

        {/* Share button */}
        <TouchableOpacity
          onPress={handleShareProfile}
          disabled={sharing}
          activeOpacity={0.75}
          style={[heroS.shareBtn, { borderColor: primaryRgba(0.45), backgroundColor: primaryRgba(0.12) }]}
        >
          {sharing
            ? <ActivityIndicator size="small" color={c.primary} />
            : <Ionicons name="share-outline" size={14} color={c.primary} />}
          <Text style={[heroS.shareBtnText, { color: c.primary }]}>
            {sharing ? 'Generating link…' : 'Share Player Profile'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  // ── Shared stats column content ────────────────────────────────────────────
  const statsColumn = (
    <>
      {/* ── 4 big stat cards ──────────────────────────────────────────── */}
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
        <StatCard label="Points / GM" value={summary.ppg.toFixed(1)} sub={`${summary.points} total`} />
        <StatCard label="Games" value={String(summary.games)} sub={`${summary.wins}W · ${summary.losses}L`} />
      </View>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <StatCard label="Win Rate" value={`${winRate}%`} sub={`${summary.wins}–${summary.losses}`} />
        <StatCard label="Rebounds / GM" value={summary.rpg.toFixed(1)} sub={`${summary.rebounds} total`} />
      </View>

      {/* ── Shooting Efficiency ───────────────────────────────────────── */}
      <SectionHeader title="Shooting Efficiency" />
      {isLandscape ? (
        <CompactShootingStrip
          fgMade={fgMade} fgAtt={fgAtt}
          threeMade={summary.threeMade} threeAtt={summary.threeAttempted}
          ftMade={summary.ftMade} ftAtt={summary.ftAttempted}
        />
      ) : (
        <View style={[shootS.card, { overflow: 'hidden', borderColor: c.border, backgroundColor: c.card }]}>
          <Gloss />
          <ArcGauge pct={fgAtt > 0 ? fgMade / fgAtt : null} label="Field Goal" made={fgMade} attempted={fgAtt} />
          <View style={[shootS.divider, { backgroundColor: c.border }]} />
          <ArcGauge pct={summary.threeAttempted > 0 ? summary.threeMade / summary.threeAttempted : null} label="3-Point" made={summary.threeMade} attempted={summary.threeAttempted} />
          <View style={[shootS.divider, { backgroundColor: c.border }]} />
          <ArcGauge pct={summary.ftAttempted > 0 ? summary.ftMade / summary.ftAttempted : null} label="Free Throw" made={summary.ftMade} attempted={summary.ftAttempted} />
        </View>
      )}

      {/* ── Playmaking & Defense (last) ───────────────────────────────── */}
      <SectionHeader title="Playmaking & Defense" />
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
        <MiniStat label="Assists / GM" value={summary.apg.toFixed(1)} total={String(summary.assists)} />
        <MiniStat label="Steals / GM"  value={summary.spg.toFixed(1)} total={String(summary.steals)}  />
      </View>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <MiniStat label="Blocks / GM"   value={summary.bpg.toFixed(1)}  total={String(summary.blocks)}    />
        <MiniStat label="Turnovers / GM" value={summary.topg.toFixed(1)} total={String(summary.turnovers)} />
      </View>
      <View style={{ height: 32 }} />
    </>
  );

  if (isLandscape) {
    return (
      <View style={lsS.row}>
        {/* Left column: hero card, fixed ~44% of screen width */}
        <View style={[lsS.heroCol, { width: Math.round(width * 0.44) - 20 }]}>
          {heroCard}
        </View>
        {/* Right column: all stats */}
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
  // Outer wrapper — shadow lives here so overflow:hidden on card doesn't clip it
  cardWrapper: {
    marginBottom: 12,
    borderRadius: 20,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.55,
    shadowRadius: 22,
    elevation: 14,
  },
  // In landscape the wrapper fills the left column — no bottom margin needed
  cardWrapperLandscape: {
    marginBottom: 0,
  },
  card: {
    borderRadius: 20,
    borderWidth: 1.5,
    alignItems: 'center',
    paddingVertical: 32,
    paddingHorizontal: 16,
    overflow: 'hidden',
  },
  // Tighter vertical padding in landscape so card fits the short screen
  cardLandscape: {
    paddingVertical: 18,
    paddingHorizontal: 14,
  },
  // Horizontal orange→transparent bar along the very top edge
  topBar: {
    position: 'absolute', top: 0, left: 0, right: 0, height: 7,
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
  },
  liveBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 18 },
  liveText:  { ...tekoStyle(12), letterSpacing: 3 },

  avatarOuter:   { marginBottom: 16, position: 'relative' },
  // Diffuse orange radial glow behind the avatar
  avatarGlow: {
    position: 'absolute',
    top: -14, left: -14, right: -14, bottom: -14,
    borderRadius: 999,
    // soft glow via shadow
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.55,
    shadowRadius: 20,
    elevation: 0,
  },
  avatarRing: {
    width: 124, height: 124, borderRadius: 62,
    borderWidth: 3,
    overflow: 'hidden',
    alignItems: 'center', justifyContent: 'center',
  },
  // Smaller avatar in landscape to fit the short screen height
  avatarRingLandscape: {
    width: 80, height: 80, borderRadius: 40,
  },
  avatarImg:      { width: '100%', height: '100%' },
  avatarFallback: { width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' },
  avatarInitials: { ...tekoStyle(44) },
  avatarInitialsLandscape: { ...tekoStyle(30) },
  cameraBadge: {
    position: 'absolute', bottom: 0, right: 0,
    width: 28, height: 28, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2,
  },
  name: { ...tekoStyle(54), letterSpacing: 1.5, marginBottom: 8 },
  nameLandscape: { ...tekoStyle(36), marginBottom: 6 },
  scopePill: {
    borderRadius: 20, borderWidth: 1,
    paddingHorizontal: 14, paddingVertical: 4,
  },
  scopeText: { fontSize: 10, fontFamily: 'Inter_500Medium', letterSpacing: 1 },
  shareBtn: {
    marginTop: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 20,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  shareBtnText: { fontSize: 12, fontFamily: 'Inter_600SemiBold', letterSpacing: 0.3 },
});

// ── Landscape two-column layout ───────────────────────────────────────────────
const lsS = StyleSheet.create({
  // Outer row that places hero card and stats side by side
  row: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'flex-start',
  },
  // Left column: fixed width (set inline from screen width), full height of card
  heroCol: {
    // width is set inline; keep a flex-shrink:0 so it never collapses
    flexShrink: 0,
  },
  // Right column: grows to fill remaining space
  statsCol: {
    flex: 1,
  },
});

const shootS = StyleSheet.create({
  card:    { flexDirection: 'row', alignItems: 'center', borderRadius: 18, borderWidth: 1, padding: 20 },
  divider: { width: 1, alignSelf: 'stretch', marginHorizontal: 4 },
});

// ─── Coach greeting header ────────────────────────────────────────────────────
function CoachGreeting() {
  const c = useColors();
  const { user } = useUser();
  const { isLoaded, isSignedIn } = useAuth();
  // Gate the query on Clerk being fully loaded + signed in.
  // Without this gate, on a cold open with a cached session the query fires
  // during the ~100ms SecureStore init window when getToken() still returns
  // null.  That gets a 401, which is not retried (by design), and the query
  // stays in error state — meData stays undefined forever — so the greeting
  // falls back to Clerk's stale "Sarah" and never updates.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: meData } = useGetMe({ query: { enabled: isLoaded && !!isSignedIn, refetchOnMount: 'always' } as any });

  const hour = new Date().getHours();
  const salutation = hour < 12 ? 'Morning' : hour < 17 ? 'Afternoon' : 'Evening';
  // Prefer the name stored in the DB (editable via Profile → Edit Name) so that
  // changes made there are reflected here without waiting for a Clerk sync.
  const firstName = meData?.firstName ?? user?.firstName ?? user?.fullName?.split(' ')[0] ?? 'Coach';

  const initials = firstName.slice(0, 1).toUpperCase();

  return (
    <View style={greetS.row}>
      {/* Avatar */}
      {user?.imageUrl ? (
        <Image
          source={{ uri: user.imageUrl }}
          style={greetS.avatar}
          contentFit="cover"
        />
      ) : (
        <View style={[greetS.avatar, greetS.avatarFallback, { backgroundColor: c.primary + '30', borderColor: c.primary + '50' }]}>
          <Text style={[greetS.initials, { color: c.primary }]}>{initials}</Text>
        </View>
      )}
      {/* Greeting text */}
      <View style={greetS.textCol}>
        <Text style={[greetS.salutation, { color: c.mutedForeground }]}>{salutation.toUpperCase()}</Text>
        <Text style={[greetS.name, { color: c.foreground }]} numberOfLines={1}>{firstName}</Text>
      </View>
    </View>
  );
}

const greetS = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 18,
    marginTop: 4,
  },
  avatar: {
    width: 46,
    height: 46,
    borderRadius: 23,
    borderWidth: 2,
  },
  avatarFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  initials: {
    fontSize: 18,
    fontFamily: 'Inter_700Bold',
  },
  textCol: {
    gap: 1,
  },
  salutation: {
    fontSize: 10,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 1.5,
  },
  name: {
    fontSize: 26,
    fontFamily: 'Inter_700Bold',
    letterSpacing: 0.2,
  },
});

// ─── Main Screen ──────────────────────────────────────────────────────────────
export default function DashboardScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { width: screenW, height: screenH } = useWindowDimensions();
  const isTablet = screenW >= 768;
  const isLandscape = screenW > screenH;

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

  const router = useRouter();

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
          <Ionicons name="person-add-outline" size={16} color="#fff" />
          <Text style={styles.emptyBtnText}>Add Players</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // Chip bar — reused in both portrait (inside ScrollView) and landscape (pinned above)
  const chipBar = (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
      {(players as any[]).map((p) => (
        <PlayerChip key={p.id} player={p} isSelected={p.id === activeId} onPress={() => setSelectedId(p.id)} />
      ))}
    </ScrollView>
  );

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      {/* ── Screen-level visual layers (behind everything) ── */}
      <ScreenGlow primary={c.primary} />
      <BasketballWatermark color={c.primary} />
      <StatsWatermark color={c.primary} />

      {/* ── Pinned chip bar (landscape only) — sits above the ScrollView ── */}
      {isLandscape && (
        <View style={[
          styles.pinnedChipBar,
          {
            paddingLeft: 16 + (insets.left ?? 0),
            paddingRight: 16 + (insets.right ?? 0),
            borderBottomColor: c.border,
          },
        ]}>
          {chipBar}
        </View>
      )}

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={[
          styles.content,
          {
            paddingTop: insets.top + (Platform.OS === 'web' ? 67 : Platform.OS === 'ios' ? 16 : 24),
            paddingBottom: insets.bottom + 100,
            paddingLeft: 16 + (insets.left ?? 0),
            paddingRight: 16 + (insets.right ?? 0),
          },
        ]}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={false} onRefresh={refetch} tintColor={c.primary} />}
      >
        {/* ── Logo banner — stretches edge-to-edge, compensating for all paddings ── */}
        <View style={[
          styles.logoBannerContainer,
          {
            height: insets.top + (isTablet ? 80 : 68),
            marginTop: -(insets.top + (Platform.OS === 'ios' ? 16 : 24)),
            marginLeft: -(16 + (insets.left ?? 0)),
            marginRight: -(16 + (insets.right ?? 0)),
          },
        ]}>
          {isTablet ? (
            // On iPad the logo-banner image is narrow relative to the wide canvas —
            // cap it at 520px and center it so it doesn't stretch or letterbox oddly.
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'flex-end' }}>
              <Image
                source={require('../../assets/images/logo-banner.png')}
                style={{ width: 520, height: 70 }}
                contentFit="contain"
              />
            </View>
          ) : (
            <Image
              source={require('../../assets/images/logo-banner.png')}
              style={styles.logoBannerImage}
              contentFit="cover"
            />
          )}
        </View>

        {/* ── Coach greeting ── */}
        <CoachGreeting />

        {/* ── Player chips — portrait only; landscape chips are pinned above ── */}
        {!isLandscape && chipBar}

        {activePlayer
          ? <PlayerDashboard player={activePlayer} />
          : <View style={styles.centered}><ActivityIndicator color={c.primary} /></View>}
      </ScrollView>
    </View>
  );
}

// Note: horizontal padding for landscape safe areas is applied dynamically via
// contentContainerStyle in the ScrollView (using insets.left / insets.right).
const styles = StyleSheet.create({
  root:    { flex: 1 },
  centered:{ flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: {},
  chips:   { paddingBottom: 14 },
  // Pinned chip bar rendered above the ScrollView in landscape so chips
  // stay visible while the coach scrolls through stats.
  pinnedChipBar: {
    paddingTop: 8,
    paddingBottom: 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  logoBannerContainer: {
    alignSelf: 'stretch',
    marginHorizontal: -16,
    marginBottom: 14,
    backgroundColor: '#050302',
    justifyContent: 'flex-end',
    overflow: 'hidden',
  },
  logoBannerImage: { width: '100%', height: 60 },
  emptyTitle: { fontSize: 20, fontFamily: 'Inter_700Bold', marginTop: 16, marginBottom: 8 },
  emptySub:   { fontSize: 14, textAlign: 'center', maxWidth: 260, fontFamily: 'Inter_400Regular', lineHeight: 20 },
  emptyBtn:   { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 24, paddingHorizontal: 24, paddingVertical: 13, borderRadius: 14 },
  emptyBtnText: { fontSize: 15, fontFamily: 'Inter_700Bold', color: '#fff' },
});
