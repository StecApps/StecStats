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
import Svg, { Circle, G } from 'react-native-svg';
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

// ─── Brand palette (dark theme) ─────────────────────────────────────────────
const BRAND = {
  orange:  '#FF531A',
  black:   '#080808',
  card:    '#101010',
  border:  'rgba(255,255,255,0.09)',
  dimText: 'rgba(255,255,255,0.45)',
};

function photoSrc(objectPath: string) {
  return `${API_BASE}/api/storage/objects/${objectPath.replace(/^\/objects\//, '')}`;
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
function OrangeGlow({ strength = 1 }: { strength?: number }) {
  return (
    <View style={StyleSheet.absoluteFillObject} pointerEvents="none">
      <LinearGradient
        colors={[
          `rgba(255,83,26,${0.30 * strength})`,
          `rgba(255,83,26,${0.10 * strength})`,
          'rgba(255,83,26,0)',
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
  const SIZE = 120, SW = 9;
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
              stroke="rgba(255,255,255,0.08)" strokeWidth={SW} fill="none" />
            <Circle cx={SIZE/2} cy={SIZE/2} r={r}
              stroke={BRAND.orange} strokeWidth={SW} fill="none"
              strokeDasharray={`${filled} ${circ}`} strokeLinecap="round" />
          </G>
        </Svg>
        <View style={gaugeS.center}>
          <Text style={gaugeS.pctNum}>{pctStr}</Text>
          {made != null && attempted != null && (
            <Text style={gaugeS.madeFrac}>{made}/{attempted}</Text>
          )}
        </View>
      </View>
      <Text style={gaugeS.label}>{label.toUpperCase()}</Text>
    </View>
  );
}
const gaugeS = StyleSheet.create({
  wrap:     { alignItems: 'center', flex: 1 },
  center:   { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  pctNum:   { ...tekoStyle(20), color: '#fff' },
  madeFrac: { fontSize: 10, fontFamily: 'Inter_400Regular', color: BRAND.dimText, marginTop: 1 },
  label:    { fontSize: 10, fontFamily: 'Inter_600SemiBold', letterSpacing: 1, color: BRAND.dimText, marginTop: 8 },
});

// ─── Player chip ─────────────────────────────────────────────────────────────
function PlayerChip({ player, isSelected, onPress }: { player: any; isSelected: boolean; onPress: () => void }) {
  const { data: summary } = useGetPlayerSummary(player.id);
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.75}
      style={[
        chipS.chip,
        {
          backgroundColor: isSelected ? BRAND.orange : BRAND.card,
          borderColor: isSelected ? BRAND.orange : BRAND.border,
          overflow: 'hidden',
        },
      ]}
    >
      {isSelected && <GlareOverlay intensity={0.18} />}
      <Text style={[chipS.name, { color: '#fff' }]}>{player.name}</Text>
      <Text style={[chipS.sub, { color: isSelected ? 'rgba(255,255,255,0.75)' : BRAND.dimText }]}>
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
  return (
    <View style={[statS.card, { overflow: 'hidden' }]}>
      <Gloss />
      <Text style={statS.label}>{label}</Text>
      <Text style={statS.value}>{value}</Text>
      {sub && <Text style={statS.sub}>{sub}</Text>}
    </View>
  );
}
const statS = StyleSheet.create({
  card:  { flex: 1, borderRadius: 16, borderWidth: 1, borderColor: BRAND.border, backgroundColor: BRAND.card, padding: 16, alignItems: 'center' },
  label: { fontSize: 9, fontFamily: 'Inter_600SemiBold', letterSpacing: 1, textTransform: 'uppercase', color: BRAND.dimText, marginBottom: 6, textAlign: 'center' },
  value: { ...tekoStyle(38), color: BRAND.orange },
  sub:   { fontSize: 10, fontFamily: 'Inter_400Regular', color: BRAND.dimText, marginTop: 2, textAlign: 'center' },
});

// ─── Mini stat (playmaking / defense) ────────────────────────────────────────
function MiniStat({ label, value, total }: { label: string; value: string; total?: string }) {
  return (
    <View style={[miniS.wrap, { overflow: 'hidden' }]}>
      <Gloss />
      <Text style={miniS.label}>{label}</Text>
      <Text style={miniS.value}>{value}</Text>
      {total && <Text style={miniS.total}>{total} TOT</Text>}
    </View>
  );
}
const miniS = StyleSheet.create({
  wrap:  { flex: 1, borderRadius: 14, borderWidth: 1, borderColor: BRAND.border, backgroundColor: BRAND.card, padding: 14, alignItems: 'center' },
  label: { fontSize: 9, fontFamily: 'Inter_600SemiBold', letterSpacing: 0.8, textTransform: 'uppercase', color: BRAND.dimText, marginBottom: 4, textAlign: 'center' },
  value: { ...tekoStyle(30), color: '#fff' },
  total: { fontSize: 9, fontFamily: 'Inter_400Regular', color: BRAND.dimText, marginTop: 2 },
});

// ─── Section header ───────────────────────────────────────────────────────────
function SectionHeader({ title }: { title: string }) {
  return (
    <View style={secS.row}>
      <View style={secS.dot} />
      <Text style={secS.title}>{title.toUpperCase()}</Text>
      <View style={{ flex: 1, height: 1, backgroundColor: BRAND.border, marginLeft: 10, alignSelf: 'center' }} />
    </View>
  );
}
const secS = StyleSheet.create({
  row:   { flexDirection: 'row', alignItems: 'center', marginBottom: 12, marginTop: 24 },
  dot:   { width: 6, height: 6, borderRadius: 3, backgroundColor: BRAND.orange, marginRight: 8 },
  title: { ...tekoStyle(20), letterSpacing: 2, color: '#fff' },
});

// ─── Player Dashboard ─────────────────────────────────────────────────────────
function PlayerDashboard({ player }: { player: any }) {
  const colors = useColors();
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
    return <View style={{ paddingVertical: 40, alignItems: 'center' }}><ActivityIndicator color={BRAND.orange} /></View>;
  }

  const fgMade = summary.twoMade + summary.threeMade;
  const fgAtt  = summary.twoAttempted + summary.threeAttempted;
  const winRate = summary.games > 0 ? Math.round((summary.wins / summary.games) * 100) : 0;
  const hasPhoto = !!player.photoObjectPath;

  return (
    <>
      {/* ── Hero card ──────────────────────────────────────────────────── */}
      <View style={heroS.card}>
        {/* Orange glow radiates from the top edge of the hero card */}
        <OrangeGlow strength={1} />
        {/* Top orange accent bar */}
        <LinearGradient
          colors={[BRAND.orange, 'rgba(255,83,26,0)']}
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
          <Ionicons name="flash" size={11} color={BRAND.orange} />
          <Text style={heroS.liveText}>LIVE STATS</Text>
          <Ionicons name="flash" size={11} color={BRAND.orange} />
        </View>

        {/* Avatar */}
        <TouchableOpacity onPress={handlePhotoTap} activeOpacity={0.85} style={heroS.avatarOuter}>
          {/* Orange glow ring behind avatar */}
          <View style={heroS.avatarGlow} />
          <View style={heroS.avatarRing}>
            {hasPhoto && authToken !== null && !photoLoadFailed ? (
              <Image
                source={{ uri: photoSrc(player.photoObjectPath), headers: { Authorization: `Bearer ${authToken}` } }}
                style={heroS.avatarImg}
                contentFit="cover"
                onError={() => setPhotoLoadFailed(true)}
              />
            ) : (
              <View style={heroS.avatarFallback}>
                <Text style={heroS.avatarInitials}>
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
          <View style={heroS.cameraBadge}>
            {uploading ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="camera" size={12} color="#fff" />}
          </View>
        </TouchableOpacity>

        {/* Name */}
        <Text style={heroS.name}>{player.name.toUpperCase()}</Text>

        {/* Season scope pill */}
        <View style={heroS.scopePill}>
          <Text style={heroS.scopeText}>
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

      {/* ── Playmaking & Defense ──────────────────────────────────────── */}
      <SectionHeader title="Playmaking & Defense" />
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
        <MiniStat label="Assists / GM" value={summary.apg.toFixed(1)} total={String(summary.assists)} />
        <MiniStat label="Steals / GM"  value={summary.spg.toFixed(1)} total={String(summary.steals)}  />
      </View>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <MiniStat label="Blocks / GM"   value={summary.bpg.toFixed(1)}  total={String(summary.blocks)}    />
        <MiniStat label="Turnovers / GM" value={summary.topg.toFixed(1)} total={String(summary.turnovers)} />
      </View>

      {/* ── Shooting Efficiency (biggest section, listed last) ────────── */}
      <SectionHeader title="Shooting Efficiency" />
      <View style={[shootS.card, { overflow: 'hidden' }]}>
        <Gloss />
        <ArcGauge pct={fgAtt > 0 ? fgMade / fgAtt : null} label="Field Goal" made={fgMade} attempted={fgAtt} />
        <View style={shootS.divider} />
        <ArcGauge pct={summary.threeAttempted > 0 ? summary.threeMade / summary.threeAttempted : null} label="3-Point" made={summary.threeMade} attempted={summary.threeAttempted} />
        <View style={shootS.divider} />
        <ArcGauge pct={summary.ftAttempted > 0 ? summary.ftMade / summary.ftAttempted : null} label="Free Throw" made={summary.ftMade} attempted={summary.ftAttempted} />
      </View>
      <View style={{ height: 32 }} />
    </>
  );
}

const heroS = StyleSheet.create({
  card: {
    borderRadius: 20,
    borderWidth: 1,
    borderColor: `rgba(255,83,26,0.40)`,
    backgroundColor: BRAND.card,
    alignItems: 'center',
    paddingVertical: 28,
    paddingHorizontal: 16,
    marginBottom: 12,
    overflow: 'hidden',
  },
  // Horizontal orange→transparent bar along the very top edge
  topBar: {
    position: 'absolute', top: 0, left: 0, right: 0, height: 3,
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
  },
  liveBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 18 },
  liveText:  { ...tekoStyle(12), color: BRAND.orange, letterSpacing: 3 },

  avatarOuter:   { marginBottom: 16, position: 'relative' },
  // Diffuse orange radial glow behind the avatar
  avatarGlow: {
    position: 'absolute',
    top: -14, left: -14, right: -14, bottom: -14,
    borderRadius: 999,
    backgroundColor: 'rgba(255,83,26,0.18)',
    // soft glow via shadow
    shadowColor: BRAND.orange,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.55,
    shadowRadius: 20,
    elevation: 0,
  },
  avatarRing: {
    width: 124, height: 124, borderRadius: 62,
    borderWidth: 3, borderColor: BRAND.orange,
    overflow: 'hidden',
    backgroundColor: 'rgba(255,83,26,0.12)',
    alignItems: 'center', justifyContent: 'center',
  },
  avatarImg:      { width: '100%', height: '100%' },
  avatarFallback: { width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' },
  avatarInitials: { ...tekoStyle(44), color: BRAND.orange },
  cameraBadge: {
    position: 'absolute', bottom: 0, right: 0,
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: BRAND.orange,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: BRAND.black,
  },
  name: { ...tekoStyle(46), color: '#fff', letterSpacing: 1.5, marginBottom: 8 },
  scopePill: {
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderRadius: 20, borderWidth: 1, borderColor: BRAND.border,
    paddingHorizontal: 14, paddingVertical: 4,
  },
  scopeText: { fontSize: 10, fontFamily: 'Inter_500Medium', letterSpacing: 1, color: BRAND.dimText },
});

const shootS = StyleSheet.create({
  card:    { flexDirection: 'row', alignItems: 'center', borderRadius: 18, borderWidth: 1, borderColor: BRAND.border, backgroundColor: BRAND.card, padding: 20 },
  divider: { width: 1, alignSelf: 'stretch', backgroundColor: BRAND.border, marginHorizontal: 4 },
});

// ─── Main Screen ──────────────────────────────────────────────────────────────
export default function DashboardScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();

  const { data: players, isLoading, refetch } = useListPlayers();
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const activeId = selectedId ?? (players?.[0] as any)?.id ?? null;
  const activePlayer = (players as any[])?.find((p) => p.id === activeId) ?? null;

  if (isLoading) {
    return (
      <View style={[styles.root, styles.centered]}>
        <ActivityIndicator color={BRAND.orange} />
      </View>
    );
  }

  if (!players?.length) {
    return (
      <View style={[styles.root, styles.centered]}>
        <Ionicons name="basketball-outline" size={52} color="rgba(255,255,255,0.25)" />
        <Text style={styles.emptyTitle}>No players yet</Text>
        <Text style={styles.emptySub}>Add players from the Profile tab to start tracking.</Text>
      </View>
    );
  }

  return (
    <View style={styles.root}>
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
        refreshControl={<RefreshControl refreshing={false} onRefresh={refetch} tintColor={BRAND.orange} />}
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
          : <View style={styles.centered}><ActivityIndicator color={BRAND.orange} /></View>}
      </ScrollView>
    </View>
  );
}

// Note: horizontal padding for landscape safe areas is applied dynamically via
// contentContainerStyle in the ScrollView (using insets.left / insets.right).
const styles = StyleSheet.create({
  root:    { flex: 1, backgroundColor: BRAND.black },
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
  emptyTitle: { fontSize: 20, fontFamily: 'Inter_700Bold', color: '#fff', marginTop: 16, marginBottom: 8 },
  emptySub:   { fontSize: 14, color: BRAND.dimText, textAlign: 'center', maxWidth: 260, fontFamily: 'Inter_400Regular', lineHeight: 20 },
});
