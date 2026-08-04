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

function photoSrc(objectPath: string) {
  return `${API_BASE}/api/storage/objects/${objectPath.replace(/^\/objects\//, '')}`;
}

// ─── Glass glare overlays ────────────────────────────────────────────────────
// White glare — neutral cards
function GlareOverlay({ intensity = 0.08 }: { intensity?: number }) {
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

// Orange-warm glare — used on primary stat cards and hero to give the
// "orange and black" depth the design needs. The orange fades to a white
// shimmer then to transparent so it reads as a warm 3-D light hit.
function OrangeGlareOverlay({ strength = 1 }: { strength?: number }) {
  return (
    <View style={StyleSheet.absoluteFillObject} pointerEvents="none">
      <LinearGradient
        colors={[
          `rgba(255,83,26,${0.18 * strength})`,
          `rgba(255,140,60,${0.10 * strength})`,
          'rgba(255,255,255,0.0)',
        ]}
        locations={[0, 0.35, 1]}
        start={{ x: 0.1, y: 0 }}
        end={{ x: 0.9, y: 0.85 }}
        style={{ flex: 1 }}
      />
    </View>
  );
}

// ─── Arc Gauge ─────────────────────────────────────────────────────────────
function ArcGauge({
  pct, label, made, attempted, colors,
}: {
  pct?: number | null; label: string; made?: number; attempted?: number; colors: any;
}) {
  const SIZE = 90, SW = 8;
  const r = (SIZE - SW) / 2;
  const circ = 2 * Math.PI * r;
  const filled = Math.max(0, Math.min(1, pct ?? 0)) * circ;
  const pctStr = pct != null && pct > 0 ? (pct * 100).toFixed(1) : '—';

  return (
    <View style={gaugeS.wrap}>
      <View style={{ width: SIZE, height: SIZE }}>
        <Svg width={SIZE} height={SIZE}>
          <G rotation="-90" origin={`${SIZE / 2},${SIZE / 2}`}>
            <Circle cx={SIZE/2} cy={SIZE/2} r={r} stroke={colors.muted} strokeWidth={SW} fill="none" />
            <Circle cx={SIZE/2} cy={SIZE/2} r={r} stroke={colors.primary} strokeWidth={SW} fill="none"
              strokeDasharray={`${filled} ${circ}`} strokeLinecap="round" />
          </G>
        </Svg>
        <View style={gaugeS.center}>
          <Text style={[gaugeS.pctNum, { color: colors.foreground }]}>{pctStr}</Text>
          {pct != null && pct > 0 && <Text style={[gaugeS.pctLabel, { color: colors.mutedForeground }]}>PCT</Text>}
        </View>
      </View>
      <Text style={[gaugeS.gaugeLabel, { color: colors.mutedForeground }]}>{label}</Text>
      {made != null && attempted != null && (
        <Text style={[gaugeS.made, { color: colors.mutedForeground }]}>{made} / {attempted}</Text>
      )}
    </View>
  );
}
const gaugeS = StyleSheet.create({
  wrap: { alignItems: 'center', flex: 1 },
  center: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  pctNum: { ...tekoStyle(19) },
  pctLabel: { fontSize: 7, fontFamily: 'Inter_500Medium', letterSpacing: 0.5 },
  gaugeLabel: { fontSize: 9, fontFamily: 'Inter_600SemiBold', letterSpacing: 0.8, textTransform: 'uppercase', marginTop: 6 },
  made: { fontSize: 11, fontFamily: 'Inter_400Regular', marginTop: 2 },
});

// ─── Player Chip ───────────────────────────────────────────────────────────
function PlayerChip({ player, isSelected, onPress, colors }: { player: any; isSelected: boolean; onPress: () => void; colors: any }) {
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
          overflow: 'hidden',
        },
      ]}
    >
      {isSelected && <GlareOverlay intensity={0.2} />}
      <Text style={[chipS.name, { color: isSelected ? '#fff' : colors.foreground }]}>{player.name}</Text>
      <Text style={[chipS.sub, { color: isSelected ? 'rgba(255,255,255,0.72)' : colors.mutedForeground }]}>
        {summary ? `${summary.games}GP · ${summary.ppg.toFixed(1)}PPG` : '…'}
      </Text>
    </TouchableOpacity>
  );
}
const chipS = StyleSheet.create({
  chip: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 22, borderWidth: 1, marginRight: 8, minWidth: 110 },
  name: { fontSize: 14, fontFamily: 'Inter_700Bold' },
  sub: { fontSize: 11, fontFamily: 'Inter_400Regular', marginTop: 2 },
});

// ─── Stat Card ─────────────────────────────────────────────────────────────
function StatCard({ label, value, sub, colors }: { label: string; value: string; sub?: string; colors: any }) {
  return (
    <View style={[statS.card, { backgroundColor: colors.card, borderColor: 'rgba(255,83,26,0.28)', overflow: 'hidden' }]}>
      <OrangeGlareOverlay />
      <Text style={[statS.label, { color: colors.mutedForeground }]}>{label}</Text>
      <Text style={[statS.value, { color: colors.primary }]}>{value}</Text>
      {sub && <Text style={[statS.sub, { color: colors.mutedForeground }]}>{sub}</Text>}
    </View>
  );
}
const statS = StyleSheet.create({
  card: { flex: 1, borderRadius: 14, borderWidth: 1, padding: 14, alignItems: 'center' },
  label: { fontSize: 9, fontFamily: 'Inter_600SemiBold', letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: 4, textAlign: 'center' },
  value: { ...tekoStyle(34) },
  sub: { fontSize: 10, fontFamily: 'Inter_400Regular', marginTop: 2, textAlign: 'center' },
});

// ─── Mini Stat ──────────────────────────────────────────────────────────────
function MiniStat({ label, value, total, colors }: { label: string; value: string; total?: string; colors: any }) {
  return (
    <View style={[miniS.wrap, { backgroundColor: colors.card, borderColor: 'rgba(255,83,26,0.22)', overflow: 'hidden' }]}>
      <OrangeGlareOverlay strength={0.7} />
      <Text style={[miniS.label, { color: colors.mutedForeground }]}>{label}</Text>
      <Text style={[miniS.value, { color: colors.foreground }]}>{value}</Text>
      {total && <Text style={[miniS.total, { color: colors.mutedForeground }]}>{total} TOTAL</Text>}
    </View>
  );
}
const miniS = StyleSheet.create({
  wrap: { flex: 1, borderRadius: 14, borderWidth: 1, padding: 14, alignItems: 'center' },
  label: { fontSize: 9, fontFamily: 'Inter_600SemiBold', letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 4, textAlign: 'center' },
  value: { ...tekoStyle(28) },
  total: { fontSize: 9, fontFamily: 'Inter_400Regular', marginTop: 2 },
});

// ─── Section Header ────────────────────────────────────────────────────────
function SectionHeader({ title, colors }: { title: string; colors: any }) {
  return (
    <View style={secS.wrap}>
      <Text style={[secS.title, { color: colors.foreground }]}>{title.toUpperCase()}</Text>
      <View style={[secS.accent, { backgroundColor: colors.primary }]} />
    </View>
  );
}
const secS = StyleSheet.create({
  wrap: { marginBottom: 12, marginTop: 22 },
  title: { ...tekoStyle(22), letterSpacing: 1.5 },
  accent: { height: 2, width: 36, borderRadius: 1, marginTop: 3 },
});

// ─── Player Dashboard ──────────────────────────────────────────────────────
function PlayerDashboard({ player, colors }: { player: any; colors: any }) {
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

  // Reset photo error state whenever the player's photo path changes (different player or photo updated)
  useEffect(() => {
    setPhotoLoadFailed(false);
  }, [player.photoObjectPath]);

  const MAX_RETRIES = 3;

  async function attemptUpload(
    asset: ImagePicker.ImagePickerAsset,
    pendingEntryId?: string,
    retryCount: number = 0,
  ) {
    setUploading(true);
    try {
      const token = await getToken();
      if (!token) throw new Error('Not signed in — please sign out and back in.');
      const mimeType = asset.mimeType ?? 'image/jpeg';
      const objectPath = await uploadPhoto(asset.uri, mimeType, token);
      await updatePlayer.mutateAsync({ playerId: player.id, data: { photoObjectPath: objectPath } });
      qc.invalidateQueries({ queryKey: getListPlayersQueryKey() });
      // Remove from the pending queue now that the upload succeeded.
      if (pendingEntryId && userId) {
        await dequeuePhoto(userId, pendingEntryId);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Please try again.';
      // Persist the failed upload so it can be retried on next app open.
      const entryId = pendingEntryId ?? (userId ? await enqueuePhoto(
        userId,
        asset.uri,
        asset.mimeType ?? 'image/jpeg',
        player.id,
      ) : undefined);
      // Guard: don't open a second alert if one is already visible.
      if (alertVisibleRef.current) return;
      alertVisibleRef.current = true;

      if (retryCount >= MAX_RETRIES) {
        // Cap reached — show a terminal message with no Retry button.
        Alert.alert(
          'Upload failed',
          'Upload failed — please check your connection and try again later.',
          [{ text: 'OK', style: 'cancel', onPress: () => { alertVisibleRef.current = false; } }],
        );
      } else {
        const delay = 1000 * Math.pow(2, retryCount); // 1s, 2s, 4s
        Alert.alert('Upload failed', msg, [
          {
            text: 'Retry',
            onPress: () => {
              alertVisibleRef.current = false;
              setTimeout(() => attemptUpload(asset, entryId, retryCount + 1), delay);
            },
          },
          { text: 'Cancel', style: 'cancel', onPress: () => { alertVisibleRef.current = false; } },
        ]);
      }
    } finally {
      setUploading(false);
    }
  }

  async function handlePhotoTap() {
    Alert.alert('Player Photo', undefined, [
      {
        text: 'Choose from Library',
        onPress: async () => {
          const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
          if (!perm.granted) {
            Alert.alert('Permission needed', 'Allow photo access in Settings to set a player photo.');
            return;
          }
          const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: 'images',
            allowsEditing: true,
            aspect: [1, 1],
            quality: 0.8,
          });
          if (result.canceled || !result.assets[0]) return;
          await attemptUpload(result.assets[0]);
        },
      },
      ...(player.photoObjectPath ? [{
        text: 'Remove Photo',
        style: 'destructive' as const,
        onPress: async () => {
          setUploading(true);
          try {
            await updatePlayer.mutateAsync({ playerId: player.id, data: { photoObjectPath: null } });
            qc.invalidateQueries({ queryKey: getListPlayersQueryKey() });
          } finally {
            setUploading(false);
          }
        },
      }] : []),
      { text: 'Cancel', style: 'cancel' },
    ]);
  }

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
  const hasPhoto = !!player.photoObjectPath;

  return (
    <>
      {/* Player Hero */}
      <View style={[heroS.card, { backgroundColor: colors.card, borderColor: 'rgba(255,83,26,0.45)', overflow: 'hidden' }]}>
        {/* Warm orange-to-transparent glass — makes the card look like it's lit by the orange brand color */}
        <OrangeGlareOverlay strength={1.2} />

        <View style={heroS.flashRow}>
          <Ionicons name="flash" size={13} color={colors.primary} />
          <Text style={[heroS.liveLabel, { color: colors.primary }]}>LIVE PLAYER STATS</Text>
          <Ionicons name="flash" size={13} color={colors.primary} />
        </View>

        {/* Tappable avatar — larger with a glare highlight on the photo */}
        <TouchableOpacity onPress={handlePhotoTap} activeOpacity={0.8} style={heroS.avatarWrap}>
          <View style={[heroS.avatar, { borderColor: colors.primary, overflow: 'hidden' }]}>
            {hasPhoto && authToken !== null && !photoLoadFailed ? (
              <Image
                source={{
                  uri: photoSrc(player.photoObjectPath),
                  headers: { Authorization: `Bearer ${authToken}` },
                }}
                style={heroS.avatarImg}
                contentFit="cover"
                onError={() => setPhotoLoadFailed(true)}
              />
            ) : (
              <Text style={[heroS.avatarText, { color: colors.primary }]}>
                {player.name.split(' ').map((w: string) => w[0]).join('').slice(0, 2).toUpperCase()}
              </Text>
            )}
            {/* Glare on avatar — diagonal highlight across the top */}
            <View style={StyleSheet.absoluteFillObject} pointerEvents="none">
              <LinearGradient
                colors={['rgba(255,255,255,0.28)', 'rgba(255,255,255,0.0)']}
                start={{ x: 0.15, y: 0 }}
                end={{ x: 0.85, y: 0.55 }}
                style={{ flex: 1 }}
              />
            </View>
          </View>
          {/* Camera badge */}
          <View style={[heroS.cameraBadge, { backgroundColor: colors.primary }]}>
            {uploading
              ? <ActivityIndicator size="small" color="#fff" />
              : <Ionicons name="camera" size={13} color="#fff" />}
          </View>
        </TouchableOpacity>

        <Text style={[heroS.playerName, { color: colors.foreground }]}>
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
      <View style={[shootS.card, { backgroundColor: colors.card, borderColor: 'rgba(255,83,26,0.22)', overflow: 'hidden' }]}>
        <OrangeGlareOverlay strength={0.8} />
        <ArcGauge pct={fgAtt > 0 ? fgMade / fgAtt : null} label="Field Goal" made={fgMade} attempted={fgAtt} colors={colors} />
        <View style={[shootS.divider, { backgroundColor: colors.border }]} />
        <ArcGauge pct={summary.threeAttempted > 0 ? summary.threeMade / summary.threeAttempted : null} label="3-Point" made={summary.threeMade} attempted={summary.threeAttempted} colors={colors} />
        <View style={[shootS.divider, { backgroundColor: colors.border }]} />
        <ArcGauge pct={summary.ftAttempted > 0 ? summary.ftMade / summary.ftAttempted : null} label="Free Throw" made={summary.ftMade} attempted={summary.ftAttempted} colors={colors} />
      </View>

      {/* Playmaking & Defense */}
      <SectionHeader title="Playmaking & Defense" colors={colors} />
      <View style={{ flexDirection: 'row', gap: 6, marginBottom: 6 }}>
        <MiniStat label="Assists / GM" value={summary.apg.toFixed(1)} total={String(summary.assists)} colors={colors} />
        <MiniStat label="Steals / GM" value={summary.spg.toFixed(1)} total={String(summary.steals)} colors={colors} />
      </View>
      <View style={{ flexDirection: 'row', gap: 6, marginBottom: 24 }}>
        <MiniStat label="Blocks / GM" value={summary.bpg.toFixed(1)} total={String(summary.blocks)} colors={colors} />
        <MiniStat label="Turnovers / GM" value={summary.topg.toFixed(1)} total={String(summary.turnovers)} colors={colors} />
      </View>
    </>
  );
}

const heroS = StyleSheet.create({
  card: { borderRadius: 16, borderWidth: 1, alignItems: 'center', paddingVertical: 22, paddingHorizontal: 16, marginBottom: 10 },
  flashRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 16 },
  // "LIVE PLAYER STATS" in Teko for a bold, condensed display feel
  liveLabel: { ...tekoStyle(13), letterSpacing: 2.5 },
  avatarWrap: { marginBottom: 14 },
  avatar: {
    width: 116, height: 116, borderRadius: 58, borderWidth: 4,
    backgroundColor: 'rgba(255,83,26,0.12)',
    alignItems: 'center', justifyContent: 'center',
  },
  avatarImg: { width: '100%', height: '100%' },
  avatarText: { ...tekoStyle(40) },
  cameraBadge: {
    position: 'absolute', bottom: 0, right: 0,
    width: 28, height: 28, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: '#0C0A09',
  },
  // Bigger, wider letter-spacing for a dramatic name display
  playerName: { ...tekoStyle(44), letterSpacing: 1.5 },
  scopeBadge: { marginTop: 8, paddingHorizontal: 12, paddingVertical: 4, borderRadius: 10 },
  scopeText: { fontSize: 10, fontFamily: 'Inter_500Medium', letterSpacing: 0.5 },
});

const shootS = StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'center', borderRadius: 14, borderWidth: 1, padding: 16 },
  divider: { width: 1, alignSelf: 'stretch', marginHorizontal: 8 },
});

// ─── Main Screen ────────────────────────────────────────────────────────────
export default function DashboardScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();

  const { data: players, isLoading, refetch } = useListPlayers();
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const activeId = selectedId ?? (players?.[0] as any)?.id ?? null;
  const activePlayer = (players as any[])?.find((p) => p.id === activeId) ?? null;

  const styles = makeStyles(colors, insets);

  if (isLoading) {
    return <View style={[styles.root, styles.centered]}><ActivityIndicator color={colors.primary} /></View>;
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
      refreshControl={<RefreshControl refreshing={false} onRefresh={refetch} tintColor={colors.primary} />}
    >
      {/* ── Brand logo banner — dark bg bleeds behind status bar,
           image sits at its natural proportions below it ── */}
      <View style={styles.logoBannerContainer}>
        <Image
          source={require('../../assets/images/logo-banner.png')}
          style={styles.logoBannerImage}
          contentFit="contain"
        />
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {(players as any[]).map((p) => (
          <PlayerChip key={p.id} player={p} isSelected={p.id === activeId} onPress={() => setSelectedId(p.id)} colors={colors} />
        ))}
      </ScrollView>

      {activePlayer
        ? <PlayerDashboard player={activePlayer} colors={colors} />
        : <View style={styles.centered}><ActivityIndicator color={colors.primary} /></View>}
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
    chips: { paddingBottom: 16 },
    // The container bleeds all the way to the top of the screen behind the
    // status bar. Its background matches the logo's dark bg so the zone above
    // the image fills seamlessly. The image itself sits at the bottom of the
    // container at its natural 60 pt height — no stretching.
    logoBannerContainer: {
      alignSelf: 'stretch',
      height: insets.top + 60,
      marginHorizontal: -16,
      marginTop: -(insets.top + (Platform.OS === 'ios' ? 16 : 24)),
      marginBottom: 16,
      backgroundColor: '#0B0806',
      justifyContent: 'flex-end',
      overflow: 'hidden',
    },
    logoBannerImage: {
      width: '100%',
      height: 60,
    },
    emptyTitle: { fontSize: 20, fontFamily: 'Inter_700Bold', color: colors.foreground, marginTop: 16, marginBottom: 8 },
    emptySub: { fontSize: 14, color: colors.mutedForeground, textAlign: 'center', maxWidth: 260, fontFamily: 'Inter_400Regular', lineHeight: 20 },
  });
}
