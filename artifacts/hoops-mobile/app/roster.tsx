import React, { useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
  ActivityIndicator,
  Alert,
  Platform,
  Animated,
} from 'react-native';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import {
  useListPlayers,
  useCreatePlayer,
  useDeletePlayer,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { Ionicons, Feather } from '@expo/vector-icons';
import { Swipeable, GestureHandlerRootView } from 'react-native-gesture-handler';

function DeleteAction({
  progress,
  onDelete,
  colors,
}: {
  progress: Animated.AnimatedInterpolation<number>;
  onDelete: () => void;
  colors: any;
}) {
  const trans = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [80, 0],
  });
  return (
    <Animated.View
      style={[
        actionStyles.container,
        { transform: [{ translateX: trans }] },
      ]}
    >
      <TouchableOpacity
        onPress={onDelete}
        activeOpacity={0.8}
        style={[actionStyles.deleteBtn, { backgroundColor: colors.destructive }]}
      >
        <Ionicons name="trash-outline" size={20} color="#fff" />
        <Text style={actionStyles.deleteText}>Delete</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

const actionStyles = StyleSheet.create({
  container: { width: 80, justifyContent: 'center', alignItems: 'flex-end' },
  deleteBtn: {
    flex: 1,
    width: 80,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    borderRadius: 10,
    marginBottom: 8,
    marginLeft: 4,
  },
  deleteText: { fontSize: 11, color: '#fff', fontFamily: 'Inter_600SemiBold' },
});

function PlayerRow({
  player,
  onDelete,
  colors,
}: {
  player: { id: number; name: string };
  onDelete: (id: number, name: string) => void;
  colors: any;
}) {
  const swipeRef = useRef<Swipeable>(null);

  function handleDelete() {
    swipeRef.current?.close();
    onDelete(player.id, player.name);
  }

  return (
    <Swipeable
      ref={swipeRef}
      friction={2}
      overshootRight={false}
      renderRightActions={(progress) => (
        <DeleteAction progress={progress} onDelete={handleDelete} colors={colors} />
      )}
    >
      <View
        style={[
          rowStyles.row,
          { backgroundColor: colors.card, borderColor: colors.border },
        ]}
      >
        <View style={[rowStyles.avatar, { backgroundColor: colors.primary + '20' }]}>
          <Text style={[rowStyles.avatarText, { color: colors.primary }]}>
            {player.name.charAt(0).toUpperCase()}
          </Text>
        </View>
        <Text style={[rowStyles.name, { color: colors.foreground }]} numberOfLines={1}>
          {player.name}
        </Text>
        <Feather name="menu" size={16} color={colors.mutedForeground} />
      </View>
    </Swipeable>
  );
}

const rowStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 8,
    gap: 12,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontSize: 16, fontFamily: 'Inter_700Bold' },
  name: { flex: 1, fontSize: 15, fontFamily: 'Inter_500Medium' },
});

export default function RosterScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const qc = useQueryClient();

  const { data: players, isLoading } = useListPlayers();
  const createMutation = useCreatePlayer();
  const deleteMutation = useDeletePlayer();

  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleAdd() {
    const name = newName.trim();
    if (!name) return;
    setSaving(true);
    try {
      await createMutation.mutateAsync({ data: { name } });
      await qc.invalidateQueries({ queryKey: ['listPlayers'] });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setNewName('');
      setShowAdd(false);
    } catch {
      Alert.alert('Error', 'Could not add player. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  function handleDeleteConfirm(id: number, name: string) {
    Alert.alert(
      'Remove Player',
      `Remove "${name}" from your roster?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteMutation.mutateAsync({ playerId: id });
              await qc.invalidateQueries({ queryKey: ['listPlayers'] });
              await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            } catch {
              Alert.alert('Error', 'Could not remove player. Please try again.');
            }
          },
        },
      ]
    );
  }

  const styles = makeStyles(colors, insets);

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} hitSlop={8}>
            <Ionicons name="chevron-back" size={24} color={colors.foreground} />
          </TouchableOpacity>
          <Text style={styles.title}>Roster</Text>
          <TouchableOpacity
            onPress={() => { setShowAdd(true); setNewName(''); }}
            style={styles.addBtn}
            hitSlop={8}
          >
            <Ionicons name="person-add-outline" size={22} color={colors.primary} />
          </TouchableOpacity>
        </View>

        {/* Add player form */}
        {showAdd && (
          <View style={[styles.addCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.addLabel, { color: colors.mutedForeground }]}>NEW PLAYER</Text>
            <View style={[styles.inputWrap, { borderColor: colors.border, backgroundColor: colors.input }]}>
              <Ionicons name="person-outline" size={16} color={colors.mutedForeground} style={{ paddingLeft: 12 }} />
              <TextInput
                style={[styles.input, { color: colors.foreground }]}
                placeholder="Player name"
                placeholderTextColor={colors.mutedForeground}
                value={newName}
                onChangeText={setNewName}
                autoFocus
                autoCapitalize="words"
                returnKeyType="done"
                onSubmitEditing={handleAdd}
              />
            </View>
            <View style={styles.addActions}>
              <TouchableOpacity
                onPress={() => { setShowAdd(false); setNewName(''); }}
                style={styles.cancelBtn}
              >
                <Text style={[styles.cancelText, { color: colors.mutedForeground }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleAdd}
                disabled={!newName.trim() || saving}
                style={[
                  styles.saveBtn,
                  { backgroundColor: colors.primary, opacity: newName.trim() && !saving ? 1 : 0.4 },
                ]}
              >
                {saving ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.saveText}>Add Player</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Player list */}
        {isLoading ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: 32 }} />
        ) : (players?.length ?? 0) === 0 ? (
          <View style={[styles.empty, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Ionicons name="people-outline" size={36} color={colors.mutedForeground} />
            <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No players yet</Text>
            <Text style={[styles.emptySub, { color: colors.mutedForeground }]}>
              Tap the{' '}
              <Text style={{ color: colors.primary }}>+ icon</Text>
              {' '}above to add your first player.
            </Text>
          </View>
        ) : (
          <>
            <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
              {players!.length} {players!.length === 1 ? 'PLAYER' : 'PLAYERS'} — SWIPE LEFT TO REMOVE
            </Text>
            {players!.map((player) => (
              <PlayerRow
                key={player.id}
                player={player}
                onDelete={handleDeleteConfirm}
                colors={colors}
              />
            ))}
          </>
        )}
      </ScrollView>
    </GestureHandlerRootView>
  );
}

function makeStyles(colors: any, insets: any) {
  return StyleSheet.create({
    content: {
      paddingTop: insets.top + (Platform.OS === 'web' ? 24 : Platform.OS === 'ios' ? 12 : 20),
      paddingHorizontal: 16,
      paddingBottom: insets.bottom + 100,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingBottom: 20,
    },
    backBtn: { padding: 4, marginRight: 8 },
    title: {
      flex: 1,
      fontSize: 22,
      fontFamily: 'Inter_700Bold',
      color: colors.foreground,
    },
    addBtn: { padding: 4 },
    addCard: {
      borderRadius: 12,
      borderWidth: 1,
      padding: 14,
      marginBottom: 20,
      gap: 10,
    },
    addLabel: {
      fontSize: 11,
      fontFamily: 'Inter_600SemiBold',
      letterSpacing: 1,
    },
    inputWrap: {
      flexDirection: 'row',
      alignItems: 'center',
      borderRadius: 8,
      borderWidth: 1,
      height: 44,
    },
    input: {
      flex: 1,
      paddingHorizontal: 10,
      fontSize: 15,
      fontFamily: 'Inter_400Regular',
    },
    addActions: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: 8,
    },
    cancelBtn: { paddingHorizontal: 14, paddingVertical: 8, justifyContent: 'center' },
    cancelText: { fontSize: 14, fontFamily: 'Inter_500Medium' },
    saveBtn: {
      paddingHorizontal: 18,
      paddingVertical: 9,
      borderRadius: 8,
      minWidth: 96,
      alignItems: 'center',
    },
    saveText: { fontSize: 14, fontFamily: 'Inter_600SemiBold', color: '#fff' },
    sectionLabel: {
      fontSize: 10,
      fontFamily: 'Inter_600SemiBold',
      letterSpacing: 1,
      marginBottom: 8,
    },
    empty: {
      borderRadius: 12,
      borderWidth: 1,
      padding: 32,
      alignItems: 'center',
      gap: 10,
      marginTop: 12,
    },
    emptyTitle: { fontSize: 17, fontFamily: 'Inter_600SemiBold' },
    emptySub: { fontSize: 14, fontFamily: 'Inter_400Regular', textAlign: 'center', lineHeight: 20 },
  });
}
