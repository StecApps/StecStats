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
} from 'react-native';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useListTeams, useCreateTeam } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { Ionicons, Feather } from '@expo/vector-icons';

export default function RecordScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const qc = useQueryClient();

  const { data: teams, isLoading: teamsLoading } = useListTeams();
  const createTeamMutation = useCreateTeam();

  const [opponent, setOpponent] = useState('');
  const [teamIdx, setTeamIdx] = useState(0);
  const [newTeamName, setNewTeamName] = useState('');
  const [showNewTeam, setShowNewTeam] = useState(false);
  const [creatingTeam, setCreatingTeam] = useState(false);

  const selectedTeam = teams?.[teamIdx] ?? null;
  const canStart = !!opponent.trim() && !!selectedTeam;

  async function handleCreateTeam() {
    if (!newTeamName.trim()) return;
    setCreatingTeam(true);
    try {
      await createTeamMutation.mutateAsync({ data: { name: newTeamName.trim(), sport: 'basketball' } });
      await qc.invalidateQueries({ queryKey: ['listTeams'] });
      setNewTeamName('');
      setShowNewTeam(false);
      setTeamIdx((teams?.length ?? 0)); // select the newly created team
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
      },
    });
  }

  const styles = makeStyles(colors, insets);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      {/* Header */}
      <View style={styles.header}>
        <View style={[styles.iconBadge, { backgroundColor: colors.primary + '20' }]}>
          <Ionicons name="videocam" size={28} color={colors.primary} />
        </View>
        <Text style={styles.title}>New Game</Text>
        <Text style={styles.subtitle}>Set up today's game and start tracking live stats</Text>
      </View>

      {/* Opponent */}
      <Text style={styles.label}>Opponent</Text>
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

      {/* Team selector */}
      <Text style={styles.label}>Your Team / Season</Text>
      {teamsLoading ? (
        <ActivityIndicator color={colors.primary} style={{ marginBottom: 16 }} />
      ) : (
        <>
          {(teams?.length ?? 0) === 0 && !showNewTeam && (
            <View style={[styles.emptyTeam, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Ionicons name="basketball-outline" size={28} color={colors.mutedForeground} />
              <Text style={[styles.emptyTeamText, { color: colors.mutedForeground }]}>
                No teams yet. Create one below.
              </Text>
            </View>
          )}

          {(teams ?? []).map((t: any, i: number) => (
            <TouchableOpacity
              key={t.id}
              onPress={() => { setTeamIdx(i); setShowNewTeam(false); }}
              activeOpacity={0.7}
              style={[
                styles.teamOption,
                {
                  backgroundColor: teamIdx === i && !showNewTeam ? colors.primary + '15' : colors.card,
                  borderColor: teamIdx === i && !showNewTeam ? colors.primary : colors.border,
                },
              ]}
            >
              <Ionicons
                name={teamIdx === i && !showNewTeam ? 'radio-button-on' : 'radio-button-off'}
                size={18}
                color={teamIdx === i && !showNewTeam ? colors.primary : colors.mutedForeground}
              />
              <Text style={[styles.teamOptionText, { color: colors.foreground }]}>{t.name}</Text>
            </TouchableOpacity>
          ))}

          {/* Add new team */}
          {showNewTeam ? (
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
          ) : (
            <TouchableOpacity
              onPress={() => setShowNewTeam(true)}
              style={[styles.addTeamBtn, { borderColor: colors.border }]}
              activeOpacity={0.7}
            >
              <Feather name="plus" size={16} color={colors.primary} />
              <Text style={[styles.addTeamText, { color: colors.primary }]}>New team / season</Text>
            </TouchableOpacity>
          )}
        </>
      )}

      {/* Start button */}
      <TouchableOpacity
        onPress={handleStart}
        disabled={!canStart}
        activeOpacity={0.8}
        style={[styles.startBtn, { backgroundColor: colors.primary, opacity: canStart ? 1 : 0.35 }]}
      >
        <Ionicons name="play-circle" size={22} color="#fff" />
        <Text style={styles.startText}>Start Game</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

function makeStyles(colors: any, insets: any) {
  return StyleSheet.create({
    content: {
      paddingTop: insets.top + (Platform.OS === 'web' ? 67 : (Platform.OS === 'ios' ? 16 : 24)),
      paddingHorizontal: 20,
      paddingBottom: insets.bottom + 120,
    },
    header: { alignItems: 'center', paddingBottom: 32 },
    iconBadge: {
      width: 64,
      height: 64,
      borderRadius: 18,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 14,
    },
    title: { fontSize: 26, fontFamily: 'Inter_700Bold', color: colors.foreground, marginBottom: 6 },
    subtitle: {
      fontSize: 14,
      color: colors.mutedForeground,
      textAlign: 'center',
      fontFamily: 'Inter_400Regular',
    },
    label: {
      fontSize: 12,
      fontFamily: 'Inter_600SemiBold',
      color: colors.mutedForeground,
      letterSpacing: 0.8,
      textTransform: 'uppercase',
      marginBottom: 8,
    },
    inputWrap: {
      flexDirection: 'row',
      alignItems: 'center',
      borderRadius: 10,
      borderWidth: 1,
      marginBottom: 20,
    },
    inputIcon: { paddingLeft: 14 },
    input: {
      flex: 1,
      height: 48,
      paddingHorizontal: 12,
      fontSize: 16,
      fontFamily: 'Inter_400Regular',
    },
    emptyTeam: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      borderRadius: 10,
      borderWidth: 1,
      padding: 14,
      marginBottom: 10,
    },
    emptyTeamText: { fontSize: 14, fontFamily: 'Inter_400Regular' },
    teamOption: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      borderRadius: 10,
      borderWidth: 1,
      padding: 14,
      marginBottom: 8,
    },
    teamOptionText: { fontSize: 15, fontFamily: 'Inter_500Medium', flex: 1 },
    newTeamWrap: {
      borderRadius: 10,
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
      color: colors.foreground,
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
    addTeamBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      borderRadius: 10,
      borderWidth: 1,
      borderStyle: 'dashed',
      padding: 14,
      marginBottom: 24,
      justifyContent: 'center',
    },
    addTeamText: { fontSize: 14, fontFamily: 'Inter_500Medium' },
    startBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 10,
      height: 56,
      borderRadius: 14,
      marginTop: 8,
    },
    startText: { fontSize: 17, fontFamily: 'Inter_700Bold', color: '#fff' },
  });
}
