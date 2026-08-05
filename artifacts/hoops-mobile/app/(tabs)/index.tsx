import React, { useState, useEffect, useRef } from 'react';
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
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { enqueuePhoto, dequeuePhoto } from '@/lib/pendingPhotoQueue';
import { uploadPhoto, API_BASE } from '@/lib/photoUpload';
import Svg, { Circle, G, Path, Rect } from 'react-native-svg';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@clerk/clerk-expo';
import {
  useListPlayers,
  useGetPlayerSummary,
  useUpdatePlayer,
  getListPlayersQueryKey,
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

// ─── Player Dashboard ─────────────────────────────────────────────────────────
function PlayerDashboard({ player }: { player: any }) {
  const c = useColors();
  // Local rgba helper keyed to the current palette's primary color
  const primaryRgba = (alpha: number) => hexToRgba(c.primary, alpha);

  const { data: summary, isLoading } = useGetPlayerSummary(player.id);
  const updatePlayer = useUpdatePlayer();
  const qc = useQueryClient();
  const { getToken, userId } = useAuth();
  const [uploading, setUploading] = useState(false);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [photoLoadFailed, setPhotoLoadFailed] = useState(false);
  const alertVisibleRef = useRef(false);

  useEffect(() => {
    getToken().then((t) => setAuthToken(t ?? null)).catch(() => {});
  }, []);

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

  return (
    <>
      {/* ── Hero card ──────────────────────────────────────────────────── */}
      <View style={[heroS.card, { borderColor: primaryRgba(0.60), backgroundColor: c.card }]}>
        {/* Orange glow radiates from the top edge of the hero card */}
        <OrangeGlow primary={c.primary} strength={1.5} />
        {/* Top orange accent bar */}
        <LinearGradient
          colors={[c.primary, primaryRgba(0)]}
          start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
          style={heroS.topBar}
        />
        {/* Glass sheen */}
        <View style={StyleSheet.absoluteFillObject} pointerEvents="none">
          <LinearGradient
            colors={['rgba(255,255,255,0.06)', 'rgba(255,255,255,0)']}
            start={{ x: 0, y: 0 }} end={{ x: 0, y: 0.5 }}
            style={{ flex: 1 }}
          />
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
          <View style={[heroS.avatarRing, { borderColor: c.primary, backgroundColor: primaryRgba(0.12) }]}>
            {hasPhoto && authToken !== null && !photoLoadFailed ? (
              <Image
                source={{ uri: photoSrc(player.photoObjectPath), headers: { Authorization: `Bearer ${authToken}` } }}
                style={heroS.avatarImg}
                contentFit="cover"
                onError={() => setPhotoLoadFailed(true)}
              />
            ) : (
              <View style={heroS.avatarFallback}>
                <Text style={[heroS.avatarInitials, { color: c.primary }]}>
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
        <Text style={[heroS.name, { color: c.cardForeground }]}>{player.name.toUpperCase()}</Text>

        {/* Season scope pill */}
        <View style={[heroS.scopePill, { borderColor: c.border, backgroundColor: c.muted }]}>
          <Text style={[heroS.scopeText, { color: c.mutedForeground }]}>
            {summary.seasonScope === 'career' ? 'CAREER' : 'SEASON'} OVERVIEW
          </Text>
        </View>
      </View>

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
      <View style={[shootS.card, { overflow: 'hidden', borderColor: c.border, backgroundColor: c.card }]}>
        <Gloss />
        <ArcGauge pct={fgAtt > 0 ? fgMade / fgAtt : null} label="Field Goal" made={fgMade} attempted={fgAtt} />
        <View style={[shootS.divider, { backgroundColor: c.border }]} />
        <ArcGauge pct={summary.threeAttempted > 0 ? summary.threeMade / summary.threeAttempted : null} label="3-Point" made={summary.threeMade} attempted={summary.threeAttempted} />
        <View style={[shootS.divider, { backgroundColor: c.border }]} />
        <ArcGauge pct={summary.ftAttempted > 0 ? summary.ftMade / summary.ftAttempted : null} label="Free Throw" made={summary.ftMade} attempted={summary.ftAttempted} />
      </View>

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
}

const heroS = StyleSheet.create({
  card: {
    borderRadius: 20,
    borderWidth: 1.5,
    alignItems: 'center',
    paddingVertical: 32,
    paddingHorizontal: 16,
    marginBottom: 12,
    overflow: 'hidden',
  },
  // Horizontal orange→transparent bar along the very top edge
  topBar: {
    position: 'absolute', top: 0, left: 0, right: 0, height: 5,
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
  avatarImg:      { width: '100%', height: '100%' },
  avatarFallback: { width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' },
  avatarInitials: { ...tekoStyle(44) },
  cameraBadge: {
    position: 'absolute', bottom: 0, right: 0,
    width: 28, height: 28, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2,
  },
  name: { ...tekoStyle(54), letterSpacing: 1.5, marginBottom: 8 },
  scopePill: {
    borderRadius: 20, borderWidth: 1,
    paddingHorizontal: 14, paddingVertical: 4,
  },
  scopeText: { fontSize: 10, fontFamily: 'Inter_500Medium', letterSpacing: 1 },
});

const shootS = StyleSheet.create({
  card:    { flexDirection: 'row', alignItems: 'center', borderRadius: 18, borderWidth: 1, padding: 20 },
  divider: { width: 1, alignSelf: 'stretch', marginHorizontal: 4 },
});

// ─── Main Screen ──────────────────────────────────────────────────────────────
export default function DashboardScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();

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
        <Text style={[styles.emptySub, { color: c.mutedForeground }]}>Add players from the Profile tab to start tracking.</Text>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      {/* ── Screen-level visual layers (behind everything) ── */}
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
            paddingLeft: 16 + (insets.left ?? 0),
            paddingRight: 16 + (insets.right ?? 0),
          },
        ]}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={false} onRefresh={refetch} tintColor={c.primary} />}
      >
        {/* ── Logo banner ── */}
        <View style={[styles.logoBannerContainer, { height: insets.top + 60, marginTop: -(insets.top + (Platform.OS === 'ios' ? 16 : 24)) }]}>
          <Image
            source={require('../../assets/images/logo-banner.png')}
            style={styles.logoBannerImage}
            contentFit="contain"
          />
        </View>

        {/* ── Player chips ── */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          {(players as any[]).map((p) => (
            <PlayerChip key={p.id} player={p} isSelected={p.id === activeId} onPress={() => setSelectedId(p.id)} />
          ))}
        </ScrollView>

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
});
