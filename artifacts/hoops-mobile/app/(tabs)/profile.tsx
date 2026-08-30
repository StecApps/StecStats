import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  Modal,
  TextInput,
  KeyboardAvoidingView,
  Pressable,
  Share,
} from 'react-native';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth, useUser } from '@clerk/expo';
import { useRouter } from 'expo-router';
import { useDeleteMyAccount, useGetBillingStatus, useListTeams, useListPlayers, useGetMe, useUpdateMe } from '@workspace/api-client-react';
import { useSubscription } from '@/lib/revenuecat';
import * as Haptics from 'expo-haptics';
import * as WebBrowser from 'expo-web-browser';
import { Ionicons, Feather } from '@expo/vector-icons';
import { ScreenGlow, BasketballWatermark } from '@/lib/ScreenBackground';
import * as Updates from 'expo-updates';
import { openStoreSubscriptions } from '@/lib/manageBilling';
import { openContactSupport } from '@/lib/supportConfig';
import { clearDeletedAccountDataThenSignOut } from '@/lib/accountDeletionCleanup';

const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}`
  : '';

function ProfileRow({
  icon,
  label,
  value,
  onPress,
  destructive,
  colors,
}: {
  icon: string;
  label: string;
  value?: string;
  onPress?: () => void;
  destructive?: boolean;
  colors: any;
}) {
  const content = (
    <View
      style={[
        rowStyle.row,
        { backgroundColor: colors.card, borderColor: colors.border },
      ]}
    >
      <View style={[rowStyle.iconWrap, { backgroundColor: destructive ? colors.destructive + '20' : colors.muted }]}>
        <Ionicons
          name={icon as any}
          size={18}
          color={destructive ? colors.destructive : colors.foreground}
        />
      </View>
      <Text
        style={[
          rowStyle.label,
          { color: destructive ? colors.destructive : colors.foreground },
        ]}
      >
        {label}
      </Text>
      {value && (
        <Text style={[rowStyle.value, { color: colors.mutedForeground }]}>{value}</Text>
      )}
      {onPress && (
        <Feather
          name="chevron-right"
          size={16}
          color={colors.mutedForeground}
          style={rowStyle.chevron}
        />
      )}
    </View>
  );
  if (onPress) {
    return (
      <TouchableOpacity onPress={onPress} activeOpacity={0.7}>
        {content}
      </TouchableOpacity>
    );
  }
  return content;
}

const rowStyle = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 13,
    marginBottom: 8,
    gap: 12,
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: { flex: 1, fontSize: 15, fontFamily: 'Inter_500Medium' },
  value: { fontSize: 14, fontFamily: 'Inter_400Regular' },
  chevron: { marginLeft: 4 },
});

const PLAN_LABELS: Record<string, string> = {
  free: 'Free',
  pro: 'Pro',
  premium: 'Premium',
};

const PLAN_COLORS: Record<string, string> = {
  free: '#B7B2AE',
  pro: '#FF531A',
  premium: '#FFB800',
};

export default function ProfileScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { signOut, getToken } = useAuth();
  const { user } = useUser();
  const { data: billing } = useGetBillingStatus();
  const { data: teams } = useListTeams();
  const { data: players } = useListPlayers();
  const { isPremium, isPro } = useSubscription();

  // Stored display name — overrides Clerk's unwritable firstName/lastName
  const { data: meData, refetch: refetchMe } = useGetMe();
  const updateMe = useUpdateMe();
  const deleteMyAccount = useDeleteMyAccount();

  // Edit name state
  const [editNameVisible, setEditNameVisible] = useState(false);
  const [editFirstName, setEditFirstName] = useState('');
  const [editLastName, setEditLastName] = useState('');
  const [savingName, setSavingName] = useState(false);

  // Displayed name: prefer DB-stored name, fall back to Clerk identity
  const storedFirst = meData?.firstName ?? null;
  const storedLast = meData?.lastName ?? null;
  const displayFirst = storedFirst ?? '';
  const displayLast = storedLast ?? user?.lastName ?? '';
  const displayName = [displayFirst, displayLast].filter(Boolean).join(' ')
    || user?.primaryEmailAddress?.emailAddress
    || 'Coach';

  function openEditName() {
    setEditFirstName(displayFirst);
    setEditLastName(displayLast);
    setEditNameVisible(true);
  }

  async function handleSaveName() {
    const first = editFirstName.trim();
    const last = editLastName.trim();
    if (!first) {
      Alert.alert('Name required', 'Please enter at least a first name.');
      return;
    }
    setSavingName(true);
    updateMe.mutate(
      { data: { firstName: first, lastName: last } },
      {
        onSuccess: () => {
          refetchMe();
          setEditNameVisible(false);
        },
        onError: (err: any) => {
          Alert.alert('Error', err?.message ?? 'Could not update name. Please try again.');
        },
        onSettled: () => setSavingName(false),
      },
    );
  }

  // YouTube connection state
  const [ytConnected, setYtConnected] = useState<boolean | null>(null);
  const [ytActionLoading, setYtActionLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getToken()
      .then((token) => {
        if (!token || cancelled) return null;
        return fetch(`${API_BASE}/api/auth/youtube/status`, {
          headers: { Authorization: `Bearer ${token}` },
        });
      })
      .then((res) => res?.json())
      .then((data) => {
        if (!cancelled && data != null) setYtConnected(data.connected ?? false);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleConnectYoutube() {
    setYtActionLoading(true);
    try {
      const token = await getToken();
      if (!token) throw new Error('Not authenticated');
      const res = await fetch(`${API_BASE}/api/auth/youtube/connect-url`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ returnTo: 'hoopsstats://' }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? 'Server error');
      }
      const { url } = await res.json();
      if (!url) throw new Error('No OAuth URL returned');

      const result = await WebBrowser.openAuthSessionAsync(url, 'hoopsstats://');
      if (result.type === 'success') {
        if (result.url.includes('youtube=connected')) {
          setYtConnected(true);
        } else {
          Alert.alert('YouTube Connect', "Couldn't connect YouTube. Please try again.");
        }
      }
      // result.type === 'cancel' means the user dismissed — do nothing
    } catch (err) {
      Alert.alert('YouTube Connect', 'Something went wrong. Please try again.');
    } finally {
      setYtActionLoading(false);
    }
  }

  async function handleDisconnectYoutube() {
    Alert.alert('Disconnect YouTube', 'Remove your YouTube channel connection?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Disconnect',
        style: 'destructive',
        onPress: async () => {
          setYtActionLoading(true);
          try {
            const token = await getToken();
            if (!token) return;
            const res = await fetch(`${API_BASE}/api/auth/youtube`, {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok) {
              const data = await res.json().catch(() => ({}));
              throw new Error(data.error ?? `Server error ${res.status}`);
            }
            setYtConnected(false);
          } catch (err) {
            Alert.alert('Error', 'Could not disconnect YouTube. Please try again.');
          } finally {
            setYtActionLoading(false);
          }
        },
      },
    ]);
  }

  // On mobile, RevenueCat is the source of truth for active subscriptions.
  // Fall back to the web billing API plan (Stripe) when RC says free, so that
  // web-purchased subscriptions also show correctly.
  const rcPlan = isPremium ? 'premium' : isPro ? 'pro' : null;
  const plan = rcPlan ?? billing?.plan ?? 'free';
  const team = teams?.[0];
  const initials = displayName
    .split(' ')
    .map((w: string) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  async function handleSignOut() {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await signOut();
  }

  async function finishDeletedAccountOnDevice(clerkUserId: string | null | undefined) {
    try {
      await clearDeletedAccountDataThenSignOut(clerkUserId, signOut);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      Alert.alert(
        'Account deleted — device cleanup needed',
        'The server accepted the deletion, but this device still has recoverable drafts or uploads. Keep the app open and retry cleanup before another person signs in.',
        [
          {
            text: 'Retry Cleanup',
            onPress: () => {
              void finishDeletedAccountOnDevice(clerkUserId);
            },
          },
        ],
        { cancelable: false },
      );
    }
  }

  function handleDeleteAccount() {
    if (deleteMyAccount.isPending) return;

    Alert.alert(
      'Delete your account?',
      'This permanently removes your teams, players, games, recordings, highlights, and profile from StecStats.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Continue',
          style: 'destructive',
          onPress: () => {
            Alert.alert(
              'Delete permanently?',
              'This cannot be undone. Deleting your StecStats account does not cancel an Apple subscription. Manage or cancel subscriptions in Apple Account Settings.',
              [
                { text: 'Keep Account', style: 'cancel' },
                {
                  text: 'Delete Account',
                  style: 'destructive',
                  onPress: () => {
                    const deletingClerkUserId = user?.id;
                    deleteMyAccount.mutate(undefined, {
                      onSuccess: async () => {
                        await finishDeletedAccountOnDevice(deletingClerkUserId);
                      },
                      onError: () => {
                        Alert.alert(
                          'Could not delete account',
                          'We could not finish deleting your account. Please sign in again and retry. Your account data may already have been removed.',
                        );
                      },
                    });
                  },
                },
              ],
            );
          },
        },
      ],
    );
  }

  const styles = makeStyles(colors, insets);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenGlow primary={colors.primary} />
      <BasketballWatermark color={colors.primary} />
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    >
      {/* Avatar */}
      <View style={styles.avatarSection}>
        <TouchableOpacity onPress={openEditName} activeOpacity={0.75}>
          <View style={[styles.avatar, { backgroundColor: colors.primary + '25' }]}>
            <Text style={[styles.avatarText, { color: colors.primary }]}>{initials}</Text>
          </View>
        </TouchableOpacity>
        <TouchableOpacity onPress={openEditName} activeOpacity={0.75} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={styles.name}>{displayName}</Text>
          <Feather name="edit-2" size={13} color={colors.mutedForeground} />
        </TouchableOpacity>
        {user?.primaryEmailAddress && (
          <Text style={[styles.email, { color: colors.mutedForeground }]}>
            {user.primaryEmailAddress.emailAddress}
          </Text>
        )}

        {/* Plan badge */}
        <View style={[styles.planBadge, { backgroundColor: PLAN_COLORS[plan] + '20', borderColor: PLAN_COLORS[plan] + '40' }]}>
          <Ionicons
            name={plan === 'premium' ? 'star' : plan === 'pro' ? 'flash' : 'basketball-outline'}
            size={13}
            color={PLAN_COLORS[plan]}
          />
          <Text style={[styles.planText, { color: PLAN_COLORS[plan] }]}>
            {PLAN_LABELS[plan]} Plan
          </Text>
        </View>
      </View>

      {/* Team section */}
      <Text style={styles.sectionTitle}>Team</Text>
      {team ? (
        <ProfileRow
          icon="basketball-outline"
          label={team.name}
          value={`${team.sport === 'soccer' ? 'Soccer' : 'Basketball'}`}
          colors={colors}
        />
      ) : (
        <ProfileRow
          icon="basketball-outline"
          label="No team yet"
          colors={colors}
        />
      )}

      {/* Roster */}
      <Text style={styles.sectionTitle}>Roster</Text>
      <ProfileRow
        icon="people-outline"
        label="Manage Players"
        value={players ? `${players.length} player${players.length === 1 ? '' : 's'}` : undefined}
        onPress={() => router.push('/roster')}
        colors={colors}
      />

      {/* Subscription */}
      <Text style={styles.sectionTitle}>Subscription</Text>
      {plan === 'free' ? (
        <TouchableOpacity
          onPress={() => router.push('/paywall')}
          activeOpacity={0.8}
          style={[styles.upgradeCard, { backgroundColor: colors.primary }]}
        >
          <Ionicons name="flash" size={20} color="#fff" />
          <View style={styles.upgradeText}>
            <Text style={styles.upgradeTitle}>Unlock Pro Features</Text>
            <Text style={styles.upgradeSub}>Career stats, video, highlights & more</Text>
          </View>
          <Feather name="chevron-right" size={18} color="#fff" />
        </TouchableOpacity>
      ) : (
        <>
          <ProfileRow
            icon={plan === 'premium' ? 'star' : 'flash'}
            label={`${PLAN_LABELS[plan]} — Active`}
            value={billing?.currentPeriodEnd
              ? `Renews ${new Date(billing.currentPeriodEnd).toLocaleDateString()}`
              : undefined}
            colors={colors}
          />
          <ProfileRow
            icon="card-outline"
              label="Manage in App Store"
              onPress={openStoreSubscriptions}
            colors={colors}
          />
        </>
      )}

      {/* YouTube */}
      <Text style={styles.sectionTitle}>YouTube</Text>
      {ytConnected === null ? (
        <ActivityIndicator color={colors.primary} style={{ alignSelf: 'flex-start', marginBottom: 8 }} />
      ) : ytConnected ? (
        <ProfileRow
          icon="logo-youtube"
          label="YouTube Connected"
          value={ytActionLoading ? 'Disconnecting…' : 'Tap to disconnect'}
          onPress={ytActionLoading ? undefined : handleDisconnectYoutube}
          colors={colors}
        />
      ) : (
        <ProfileRow
          icon="logo-youtube"
          label={ytActionLoading ? 'Connecting…' : 'Connect YouTube'}
          value="Share highlights to your channel"
          onPress={ytActionLoading ? undefined : handleConnectYoutube}
          colors={colors}
        />
      )}

      {/* Support & Legal */}
      <Text style={styles.sectionTitle}>Support & Legal</Text>
      <ProfileRow
        icon="mail-outline"
        label="Contact Support"
        onPress={openContactSupport}
        colors={colors}
      />
      <ProfileRow
        icon="shield-checkmark-outline"
        label="Privacy Policy"
        onPress={() => {
          const domain = process.env.EXPO_PUBLIC_DOMAIN ?? 'stecstats.com';
          WebBrowser.openBrowserAsync(`https://${domain}/privacy`);
        }}
        colors={colors}
      />
      <ProfileRow
        icon="document-text-outline"
        label="Terms of Use"
        onPress={() => {
          const domain = process.env.EXPO_PUBLIC_DOMAIN ?? 'stecstats.com';
          WebBrowser.openBrowserAsync(`https://${domain}/terms`);
        }}
        colors={colors}
      />

      {/* About — surfaces the EAS update group ID so rollback verification
           is possible without developer tools. `updateGroup` is the UUID
           used by `eas update --republish --group <id>` and matches the
           group listed in the Expo dashboard. Tap the row to open the
           native share sheet so a tester can paste/record it. */}
      <Text style={styles.sectionTitle}>About</Text>
      {(() => {
        const channel = Updates.channel ?? 'dev';
        // EAS Update manifests include the group UUID in metadata.updateGroup.
        // This is the same ID required by `eas update --republish --group`.
        // Falls back to updateId (individual update) when metadata is absent,
        // then to null in a local dev build where Updates is disabled.
        const manifest = Updates.manifest as any;
        // updateGroup is the EAS group UUID used by `eas update:republish --group`.
        // It is only present in EAS-delivered manifests (production / preview channels).
        // Updates.updateId is a per-platform asset ID — NOT a group ID — so we do NOT
        // expose it as a rollback target. Dev builds and Expo Go show "dev build".
        const groupId: string | null =
          manifest?.metadata?.updateGroup ?? null;
        const shortId = groupId ? groupId.slice(-8) : null;
        const fullLabel = shortId
          ? `${channel}  ·  …${shortId}`
          : `${channel}  ·  dev build`;
        return (
          <ProfileRow
            icon="information-circle-outline"
            label="Bundle"
            value={fullLabel}
            onPress={groupId ? () => {
              // Share sheet lets the tester forward the full group UUID to use in:
              //   eas update:republish --group <groupId> --destination-channel <ch>
              Share.share({ message: groupId, title: 'EAS Update Group ID' });
            } : undefined}
            colors={colors}
          />
        );
      })()}

      {/* Account */}
      <Text style={styles.sectionTitle}>Account</Text>
      <ProfileRow
        icon="trash-outline"
        label={deleteMyAccount.isPending ? 'Deleting Account…' : 'Delete Account'}
        onPress={deleteMyAccount.isPending ? undefined : handleDeleteAccount}
        destructive
        colors={colors}
      />
      <ProfileRow
        icon="log-out-outline"
        label="Sign Out"
        onPress={handleSignOut}
        destructive
        colors={colors}
      />
    </ScrollView>

    {/* ── Edit Name Modal ──────────────────────────────────────────────── */}
    <Modal
      visible={editNameVisible}
      transparent
      animationType="slide"
      onRequestClose={() => setEditNameVisible(false)}
    >
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' }} onPress={() => setEditNameVisible(false)} />
        <View style={[editNameStyle.sheet, { backgroundColor: colors.card }]}>
          <View style={[editNameStyle.handle, { backgroundColor: colors.border }]} />
          <Text style={[editNameStyle.title, { color: colors.foreground }]}>Edit Name</Text>

          <Text style={[editNameStyle.label, { color: colors.mutedForeground }]}>First name</Text>
          <TextInput
            style={[editNameStyle.input, { backgroundColor: colors.background, borderColor: colors.border, color: colors.foreground }]}
            value={editFirstName}
            onChangeText={setEditFirstName}
            placeholder="First name"
            placeholderTextColor={colors.mutedForeground}
            autoCapitalize="words"
            autoFocus
            returnKeyType="next"
          />

          <Text style={[editNameStyle.label, { color: colors.mutedForeground }]}>Last name</Text>
          <TextInput
            style={[editNameStyle.input, { backgroundColor: colors.background, borderColor: colors.border, color: colors.foreground }]}
            value={editLastName}
            onChangeText={setEditLastName}
            placeholder="Last name (optional)"
            placeholderTextColor={colors.mutedForeground}
            autoCapitalize="words"
            returnKeyType="done"
            onSubmitEditing={handleSaveName}
          />

          <TouchableOpacity
            onPress={handleSaveName}
            disabled={savingName}
            activeOpacity={0.8}
            style={[editNameStyle.saveBtn, { backgroundColor: colors.primary, opacity: savingName ? 0.6 : 1 }]}
          >
            {savingName
              ? <ActivityIndicator color="#fff" size="small" />
              : <Text style={editNameStyle.saveBtnText}>Save</Text>
            }
          </TouchableOpacity>

          <TouchableOpacity onPress={() => setEditNameVisible(false)} style={{ alignItems: 'center', paddingVertical: 12 }}>
            <Text style={{ color: colors.mutedForeground, fontSize: 14, fontFamily: 'Inter_400Regular' }}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Modal>
    </View>
  );
}

const editNameStyle = StyleSheet.create({
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 36,
  },
  handle: { width: 36, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: 16 },
  title: { fontSize: 18, fontFamily: 'Inter_700Bold', marginBottom: 20, textAlign: 'center' },
  label: { fontSize: 12, fontFamily: 'Inter_500Medium', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    fontFamily: 'Inter_400Regular',
    marginBottom: 16,
  },
  saveBtn: {
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 4,
    marginBottom: 4,
  },
  saveBtnText: { fontSize: 16, fontFamily: 'Inter_700Bold', color: '#fff' },
});

function makeStyles(colors: any, insets: any) {
  return StyleSheet.create({
    content: {
      paddingTop: insets.top + (Platform.OS === 'web' ? 67 : (Platform.OS === 'ios' ? 16 : 24)),
      paddingLeft: 16 + (insets.left ?? 0),
      paddingRight: 16 + (insets.right ?? 0),
      paddingBottom: insets.bottom + 100,
    },
    avatarSection: { alignItems: 'center', paddingBottom: 28 },
    avatar: {
      width: 72,
      height: 72,
      borderRadius: 36,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 12,
    },
    avatarText: { fontSize: 26, fontFamily: 'Inter_700Bold' },
    name: { fontSize: 20, fontFamily: 'Inter_700Bold', color: colors.foreground, marginBottom: 4 },
    email: { fontSize: 14, fontFamily: 'Inter_400Regular', marginBottom: 12 },
    planBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      paddingHorizontal: 12,
      paddingVertical: 5,
      borderRadius: 20,
      borderWidth: 1,
    },
    planText: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
    sectionTitle: {
      fontSize: 11,
      fontFamily: 'Inter_600SemiBold',
      color: colors.mutedForeground,
      letterSpacing: 1,
      textTransform: 'uppercase',
      marginBottom: 8,
      marginTop: 4,
    },
    upgradeCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      borderRadius: 12,
      padding: 16,
      marginBottom: 16,
    },
    upgradeText: { flex: 1 },
    upgradeTitle: { fontSize: 15, fontFamily: 'Inter_700Bold', color: '#fff', marginBottom: 2 },
    upgradeSub: { fontSize: 12, color: 'rgba(255,255,255,0.8)', fontFamily: 'Inter_400Regular' },
  });
}


