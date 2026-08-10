import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Platform,
  Switch,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useListTeams, useCreateTeam } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { Ionicons, Feather } from '@expo/vector-icons';
import { tekoStyle } from '@/lib/tekoStyle';
import { ScreenGlow, BasketballWatermark } from '@/lib/ScreenBackground';

export default function RecordScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const qc = useQueryClient();

  const { data: teams, isLoading: teamsLoading } = useListTeams();
  const createTeamMutation = useCreateTeam();

  const [opponent, setOpponent] = useState('');
  const [teamIdx, setTeamIdx] = useState(0);
  const [teamDropOpen, setTeamDropOpen] = useState(false);
  const [newTeamName, setNewTeamName] = useState('');
  const [showNewTeam, setShowNewTeam] = useState(false);
  const [creatingTeam, setCreatingTeam] = useState(false);
  const [recordVideo, setRecordVideo] = useState(false);

  const selectedTeam = (teams as any[])?.[teamIdx] ?? null;
  const canStart = !!opponent.trim() && !!selectedTeam;

  async function handleCreateTeam() {
    if (!newTeamName.trim()) return;
    setCreatingTeam(true);
    try {
      await createTeamMutation.mutateAsync({ data: { name: newTeamName.trim(), sport: 'basketball' } });
      await qc.invalidateQueries({ queryKey: ['listTeams'] });
      setNewTeamName('');
      setShowNewTeam(false);
      setTeamDropOpen(false);
      setTeamIdx((teams?.length ?? 0));
    } finally {
      setCreatingTeam(false);
    }
  }

  async function handleStart() {
    if (!canStart) return;
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    router.push({
      pathname: '/scorekeeper',
      params: {
        opponent: opponent.trim(),
        teamId: String(selectedTeam!.id),
        teamName: selectedTeam!.name,
        date: new Date().toISOString().split('T')[0],
        recordVideo: recordVideo ? 'true' : 'false',
      },
    });
  }

  const styles = makeStyles(colors, insets);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {/* ── Background decorations ─────────────────────────────────────────── */}
      <ScreenGlow primary={colors.primary} />
      <BasketballWatermark color={colors.primary} />

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* ── Slim header ───────────────────────────────────────────────────── */}
        <View style={styles.header}>
          <Text style={[tekoStyle(36), { color: colors.foreground, letterSpacing: 1 }]}>
            NEW GAME
          </Text>
          <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
            Set up and start tracking live stats
          </Text>
        </View>

        {/* ── Opponent ──────────────────────────────────────────────────────── */}
        <Text style={[styles.label, { color: colors.mutedForeground }]}>Opponent</Text>
        <View style={[styles.inputWrap, { backgroundColor: colors.input, borderColor: colors.border }]}>
          <Feather name="users" size={16} color={colors.mutedForeground} style={styles.inputIcon} />
          <TextInput
            style={[styles.input, { color: colors.foreground }]}
            placeholder="e.g. Roosevelt Eagles"
            placeholderTextColor={colors.mutedForeground}
            value={opponent}
            onChangeText={setOpponent}
            returnKeyType="next"
            autoCapitalize="words"
          />
        </View>

        {/* ── Your Team / Season dropdown ───────────────────────────────────── */}
        <Text style={[styles.label, { color: colors.mutedForeground }]}>Your Team / Season</Text>
        {teamsLoading ? (
          <ActivityIndicator color={colors.primary} style={{ marginBottom: 16 }} />
        ) : (
          <>
            {/* Collapsed trigger row */}
            {(teams?.length ?? 0) === 0 && !showNewTeam ? (
              <TouchableOpacity
                onPress={() => setShowNewTeam(true)}
                activeOpacity={0.75}
                style={[styles.emptyTeam, { backgroundColor: colors.card, borderColor: colors.primary + '60' }]}
              >
                <Ionicons name="add-circle-outline" size={22} color={colors.primary} />
                <Text style={[styles.emptyTeamText, { color: colors.primary }]}>
                  Tap to add your first team
                </Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                onPress={() => { setTeamDropOpen((v) => !v); setShowNewTeam(false); }}
                activeOpacity={0.75}
                style={[
                  styles.dropdownTrigger,
                  { backgroundColor: colors.card, borderColor: teamDropOpen ? colors.primary : colors.border },
                ]}
              >
                <View style={[styles.teamDot, { backgroundColor: colors.primary }]} />
                <Text
                  style={[styles.dropdownLabel, { color: selectedTeam ? colors.foreground : colors.mutedForeground }]}
                  numberOfLines={1}
                >
                  {selectedTeam?.name ?? 'Select a team'}
                </Text>
                {selectedTeam?.sport && (
                  <Text style={[styles.sportBadge, { color: colors.primary, backgroundColor: colors.primary + '18' }]}>
                    {selectedTeam.sport === 'soccer' ? '⚽' : '🏀'}
                  </Text>
                )}
                <Ionicons
                  name={teamDropOpen ? 'chevron-up' : 'chevron-down'}
                  size={16}
                  color={colors.mutedForeground}
                />
              </TouchableOpacity>
            )}

            {/* Expanded team list */}
            {teamDropOpen && (
              <View style={[styles.dropdownList, { backgroundColor: colors.card, borderColor: colors.primary + '40' }]}>
                {(teams as any[] ?? []).map((t: any, i: number) => {
                  const sel = teamIdx === i;
                  return (
                    <TouchableOpacity
                      key={t.id}
                      onPress={() => {
                        setTeamIdx(i);
                        setTeamDropOpen(false);
                        setShowNewTeam(false);
                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      }}
                      activeOpacity={0.7}
                      style={[styles.dropdownItem, sel && { backgroundColor: colors.primary + '14' }]}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.dropdownItemText, { color: sel ? colors.primary : colors.foreground }]} numberOfLines={1}>
                          {t.name}
                        </Text>
                        {t.sport && (
                          <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: 'Inter_400Regular', marginTop: 1 }}>
                            {t.sport === 'soccer' ? '⚽ Soccer League' : '🏀 Basketball League'}
                          </Text>
                        )}
                      </View>
                      {sel && <Ionicons name="checkmark" size={16} color={colors.primary} />}
                    </TouchableOpacity>
                  );
                })}
                {/* Add new team / season row */}
                <TouchableOpacity
                  onPress={() => { setShowNewTeam(true); setTeamDropOpen(false); }}
                  style={[styles.dropdownItem, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }]}
                  activeOpacity={0.7}
                >
                  <Feather name="plus" size={14} color={colors.primary} />
                  <Text style={[styles.dropdownItemText, { color: colors.primary }]}>New team / season</Text>
                </TouchableOpacity>
              </View>
            )}

            {/* Inline new-team form */}
            {showNewTeam && (
              <View style={[styles.newTeamWrap, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <TextInput
                  style={[styles.newTeamInput, { color: colors.foreground, borderColor: colors.border }]}
                  placeholder="Team / season name"
                  placeholderTextColor={colors.mutedForeground}
                  value={newTeamName}
                  onChangeText={setNewTeamName}
                  autoFocus
                  returnKeyType="done"
                  onSubmitEditing={handleCreateTeam}
                />
                <View style={styles.newTeamBtns}>
                  <TouchableOpacity onPress={() => setShowNewTeam(false)} style={styles.cancelBtn}>
                    <Text style={[styles.cancelText, { color: colors.mutedForeground }]}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={handleCreateTeam}
                    style={[styles.saveTeamBtn, { backgroundColor: colors.primary }]}
                    disabled={!newTeamName.trim() || creatingTeam}
                  >
                    {creatingTeam ? (
                      <ActivityIndicator color="#fff" size="small" />
                    ) : (
                      <Text style={styles.saveTeamText}>Save</Text>
                    )}
                  </TouchableOpacity>
                </View>
              </View>
            )}
          </>
        )}

        {/* ── Record Video toggle ───────────────────────────────────────────── */}
        <View style={[styles.toggleRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={styles.toggleLeft}>
            <View style={[styles.toggleIcon, { backgroundColor: recordVideo ? colors.primary + '20' : colors.muted }]}>
              <Ionicons
                name="videocam"
                size={18}
                color={recordVideo ? colors.primary : colors.mutedForeground}
              />
            </View>
            <View style={styles.toggleText}>
              <Text style={[styles.toggleTitle, { color: colors.foreground }]}>Record Video</Text>
              <Text style={[styles.toggleSub, { color: colors.mutedForeground }]}>
                Film the game from your phone
              </Text>
            </View>
          </View>
          <Switch
            value={recordVideo}
            onValueChange={(v) => { setRecordVideo(v); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
            trackColor={{ false: colors.muted, true: colors.primary + '80' }}
            thumbColor={recordVideo ? colors.primary : colors.mutedForeground}
          />
        </View>

        {/* ── Start button ──────────────────────────────────────────────────── */}
        <TouchableOpacity
          onPress={handleStart}
          disabled={!canStart}
          activeOpacity={0.8}
          style={[styles.startBtn, { backgroundColor: colors.primary, opacity: canStart ? 1 : 0.35, overflow: 'hidden' }]}
        >
          <LinearGradient
            colors={['rgba(255,255,255,0.18)', 'rgba(255,255,255,0)'] as any}
            start={{ x: 0.1, y: 0 }}
            end={{ x: 0.9, y: 1 }}
            style={StyleSheet.absoluteFillObject}
          />
          <Ionicons name={recordVideo ? 'videocam' : 'play-circle'} size={22} color="#fff" />
          <Text style={styles.startText}>{recordVideo ? 'Start & Record' : 'Start Game'}</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

function makeStyles(colors: any, insets: any) {
  return StyleSheet.create({
    content: {
      paddingTop: insets.top + (Platform.OS === 'web' ? 67 : 20),
      paddingHorizontal: 20,
      paddingBottom: insets.bottom + 120,
    },
    header: { alignItems: 'center', paddingBottom: 22 },
    subtitle: {
      fontSize: 14,
      fontFamily: 'Inter_400Regular',
      textAlign: 'center',
      marginTop: 3,
    },
    label: {
      fontSize: 11,
      fontFamily: 'Inter_600SemiBold',
      letterSpacing: 0.9,
      textTransform: 'uppercase',
      marginBottom: 8,
    },
    inputWrap: {
      flexDirection: 'row',
      alignItems: 'center',
      borderRadius: 12,
      borderWidth: 1,
      marginBottom: 20,
    },
    inputIcon: { paddingLeft: 14 },
    input: {
      flex: 1,
      height: 50,
      paddingHorizontal: 12,
      fontSize: 16,
      fontFamily: 'Inter_400Regular',
    },
    emptyTeam: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      borderRadius: 12,
      borderWidth: 1,
      padding: 14,
      marginBottom: 16,
    },
    emptyTeamText: { fontSize: 14, fontFamily: 'Inter_400Regular' },
    dropdownTrigger: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      borderRadius: 12,
      borderWidth: 1,
      paddingHorizontal: 14,
      paddingVertical: 13,
      marginBottom: 6,
    },
    teamDot: { width: 8, height: 8, borderRadius: 4 },
    dropdownLabel: { flex: 1, fontSize: 15, fontFamily: 'Inter_600SemiBold' },
    sportBadge: {
      fontSize: 14,
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: 8,
    },
    dropdownList: {
      borderRadius: 12,
      borderWidth: 1,
      marginBottom: 8,
      overflow: 'hidden',
    },
    dropdownItem: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
    dropdownItemText: { fontSize: 15, fontFamily: 'Inter_500Medium' },
    newTeamWrap: {
      borderRadius: 12,
      borderWidth: 1,
      padding: 14,
      marginBottom: 8,
      gap: 10,
    },
    newTeamInput: {
      height: 42,
      borderWidth: 1,
      borderRadius: 8,
      paddingHorizontal: 12,
      fontSize: 15,
      fontFamily: 'Inter_400Regular',
    },
    newTeamBtns: { flexDirection: 'row', gap: 8, justifyContent: 'flex-end' },
    cancelBtn: { paddingHorizontal: 14, paddingVertical: 8 },
    cancelText: { fontSize: 14, fontFamily: 'Inter_500Medium' },
    saveTeamBtn: {
      paddingHorizontal: 18,
      paddingVertical: 8,
      borderRadius: 8,
      minWidth: 64,
      alignItems: 'center',
    },
    saveTeamText: { fontSize: 14, fontFamily: 'Inter_600SemiBold', color: '#fff' },
    toggleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      borderRadius: 12,
      borderWidth: 1,
      padding: 14,
      marginTop: 14,
      marginBottom: 14,
    },
    toggleLeft: { flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 },
    toggleIcon: {
      width: 36,
      height: 36,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
    },
    toggleText: { flex: 1 },
    toggleTitle: { fontSize: 15, fontFamily: 'Inter_600SemiBold', marginBottom: 2 },
    toggleSub: { fontSize: 12, fontFamily: 'Inter_400Regular' },
    startBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 10,
      height: 58,
      borderRadius: 16,
    },
    startText: { fontSize: 18, fontFamily: 'Inter_700Bold', color: '#fff' },
  });
}
