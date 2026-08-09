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
} from 'react-native';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth, useUser } from '@clerk/clerk-expo';
import { useRouter } from 'expo-router';
import { useGetBillingStatus, useListTeams, useListPlayers } from '@workspace/api-client-react';
import { useSubscription } from '@/lib/revenuecat';
import * as Haptics from 'expo-haptics';
import * as WebBrowser from 'expo-web-browser';
import { Ionicons, Feather } from '@expo/vector-icons';
import { ScreenGlow, BasketballWatermark } from '@/lib/ScreenBackground';

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
  const initials = (user?.fullName ?? user?.primaryEmailAddress?.emailAddress ?? '?')
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  async function handleSignOut() {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await signOut();
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
        <View style={[styles.avatar, { backgroundColor: colors.primary + '25' }]}>
          <Text style={[styles.avatarText, { color: colors.primary }]}>{initials}</Text>
        </View>
        <Text style={styles.name}>
          {user?.fullName ?? user?.primaryEmailAddress?.emailAddress ?? 'Coach'}
        </Text>
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
            label={rcPlan ? (Platform.OS === 'android' ? 'Manage in Google Play' : 'Manage in App Store') : 'Manage Billing'}
            onPress={async () => {
              if (rcPlan) {
                // RC subscriber must cancel through the OS store, not the web portal.
                // itms-apps:// is the correct deep-link scheme for the App Store on iOS;
                // it must be declared in LSApplicationQueriesSchemes (app.json) so that
                // Linking.canOpenURL returns true on iOS 9+.
                const url = Platform.OS === 'android'
                  ? 'https://play.google.com/store/account/subscriptions'
                  : 'itms-apps://apps.apple.com/account/subscriptions';
                const supported = await Linking.canOpenURL(url);
                if (supported) {
                  Linking.openURL(url).catch(() => {
                    Alert.alert(
                      'Store Unavailable',
                      Platform.OS === 'android'
                        ? 'Unable to open Google Play. Please manage your subscription from the Play Store app.'
                        : 'Unable to open the App Store. Please manage your subscription from the App Store app.',
                    );
                  });
                } else {
                  // Fallback: open the https equivalent in Safari so the user still
                  // reaches their subscription management page.
                  const fallback = Platform.OS === 'android'
                    ? 'https://play.google.com/store/account/subscriptions'
                    : 'https://apps.apple.com/account/subscriptions';
                  Linking.openURL(fallback).catch(() => {
                    Alert.alert(
                      'Store Unavailable',
                      Platform.OS === 'android'
                        ? 'Unable to open Google Play. Please manage your subscription from the Play Store app.'
                        : 'Unable to open the App Store. Please manage your subscription from the App Store app.',
                    );
                  });
                }
              } else {
                // Stripe / web subscription — open billing portal
                const domain = process.env.EXPO_PUBLIC_DOMAIN;
                if (!domain) {
                  console.warn('[Profile] EXPO_PUBLIC_DOMAIN is not set — cannot open billing portal');
                  Alert.alert(
                    'Billing Unavailable',
                    'Unable to open billing management right now. Please try again later or visit the website.',
                  );
                  return;
                }
                const billingUrl = `https://${domain}/billing`;
                try {
                  const canOpen = await Linking.canOpenURL(billingUrl);
                  if (!canOpen) {
                    Alert.alert(
                      'Billing Unavailable',
                      'Your device was unable to open the billing page. Please visit the website to manage your subscription.',
                    );
                    return;
                  }
                  await Linking.openURL(billingUrl);
                } catch (err) {
                  console.warn('[Profile] Failed to open billing portal:', err);
                  Alert.alert(
                    'Billing Unavailable',
                    'Something went wrong opening billing management. Please try again later.',
                  );
                }
              }
            }}
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
        onPress={() => Linking.openURL('mailto:support@stecstats.com')}
        colors={colors}
      />
      <ProfileRow
        icon="shield-checkmark-outline"
        label="Privacy Policy"
        onPress={() => Linking.openURL('https://stecstats.com/privacy')}
        colors={colors}
      />

      {/* Account */}
      <Text style={styles.sectionTitle}>Account</Text>
      <ProfileRow
        icon="log-out-outline"
        label="Sign Out"
        onPress={handleSignOut}
        destructive
        colors={colors}
      />
    </ScrollView>
    </View>
  );
}

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


