import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
  Platform,
} from 'react-native';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useSubscription } from '@/lib/revenuecat';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useQueryClient } from '@tanstack/react-query';
import { getGetBillingStatusQueryKey } from '@workspace/api-client-react';

// ─── Feature lists ────────────────────────────────────────────────────────────
// KEEP IN SYNC with the web app: artifacts/hoops-stats/src/pages/pricing.tsx
// (FREE_FEATURES, PRO_FEATURES) and artifacts/hoops-stats/src/pages/billing.tsx
// (PREMIUM_FEATURES). If you change copy here, change it there too (and vice versa).
// ──────────────────────────────────────────────────────────────────────────────

const FREE_FEATURES = [
  '1 player',
  'Current season stats',
  'Basic box scores',
];

const PRO_FEATURES = [
  'Unlimited players & seasons',
  'Full career dashboard',
  'Shooting gauges & advanced stats',
  'Live streaming to family & fans',
  'Saved game video & highlight reels',
  'YouTube highlight upload with auto box score',
  'Shareable player profile',
];

const PREMIUM_FEATURES = [
  'Everything in Pro',
  'Auto-Follow camera during recording',
  'Player tracking photos',
  'More features coming',
];

export default function PaywallScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { offerings, purchase, restore, isPurchasing, isRestoring, isPro, isPremium, configured } =
    useSubscription();

  const [selectedPkg, setSelectedPkg] = useState<any | null>(null);
  const currentOffering = offerings?.current;
  const packages = currentOffering?.availablePackages ?? [];

  // Pre-select first package
  React.useEffect(() => {
    if (packages.length > 0 && !selectedPkg) {
      setSelectedPkg(packages[0]);
    }
  }, [packages]);

  async function handlePurchase() {
    if (!selectedPkg) return;
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      await purchase(selectedPkg);
      queryClient.invalidateQueries({ queryKey: getGetBillingStatusQueryKey() });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
    } catch (err: any) {
      if (!err?.userCancelled) {
        Alert.alert('Purchase failed', err?.message ?? 'Please try again');
      }
    }
  }

  async function handleRestore() {
    try {
      await restore();
      queryClient.invalidateQueries({ queryKey: getGetBillingStatusQueryKey() });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert('Purchases restored', 'Your subscription has been restored.');
      router.back();
    } catch {
      Alert.alert('Restore failed', 'No purchases found to restore.');
    }
  }

  const styles = makeStyles(colors, insets);

  // Find the pro package from RevenueCat offerings
  const proPackage = packages[0] ?? null;
  const proPrice = proPackage?.product?.priceString ?? '$9.99';

  return (
    <View style={styles.root}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* Close */}
        <TouchableOpacity onPress={() => router.back()} style={styles.closeBtn}>
          <Ionicons name="close" size={22} color={colors.mutedForeground} />
        </TouchableOpacity>

        {/* Hero */}
        <View style={styles.hero}>
          <Image
            source={require('@/assets/images/logo.png')}
            style={styles.heroLogo}
            contentFit="contain"
          />
          <Text style={styles.heroTitle}>Pick Your Plan</Text>
          <Text style={styles.heroSub}>
            Start free. Upgrade to Pro whenever you want the full career picture, live streaming, and highlight reels.
          </Text>
        </View>

        {/* FREE tier */}
        <View style={[styles.tierCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={styles.tierHeader}>
            <Text style={[styles.tierName, { color: colors.foreground, fontFamily: 'Teko_700Bold' }]}>FREE</Text>
            <Text style={[styles.tierPrice, { color: colors.foreground, fontFamily: 'Teko_700Bold' }]}>
              $0 <Text style={[styles.tierPriceSub, { color: colors.mutedForeground }]}>/ forever</Text>
            </Text>
          </View>
          {FREE_FEATURES.map((f) => (
            <View key={f} style={styles.featureRow}>
              <Ionicons name="checkmark" size={14} color={colors.mutedForeground} />
              <Text style={[styles.featureText, { color: colors.mutedForeground }]}>{f}</Text>
            </View>
          ))}
          <TouchableOpacity
            onPress={() => router.back()}
            style={[styles.freeCta, { borderColor: colors.border }]}
          >
            <Text style={[styles.freeCtaText, { color: colors.mutedForeground }]}>Go to Dashboard</Text>
          </TouchableOpacity>
        </View>

        {/* PRO tier */}
        <View style={[styles.tierCard, styles.proCard, { backgroundColor: colors.card, borderColor: colors.primary }]}>
          {/* Badge */}
          <View style={[styles.trialBadge, { backgroundColor: colors.primary }]}>
            <Text style={styles.trialBadgeText}>14-DAY FREE TRIAL</Text>
          </View>

          <View style={styles.tierHeader}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Ionicons name="flash" size={18} color={colors.primary} />
              <Text style={[styles.tierName, { color: colors.primary, fontFamily: 'Teko_700Bold' }]}>PRO</Text>
            </View>
            {configured ? (
              <Text style={[styles.tierPrice, { color: colors.foreground, fontFamily: 'Teko_700Bold' }]}>
                {proPrice} <Text style={[styles.tierPriceSub, { color: colors.mutedForeground }]}>/ month</Text>
              </Text>
            ) : (
              <Text style={[styles.tierPrice, { color: colors.foreground, fontFamily: 'Teko_700Bold' }]}>
                $9.99 <Text style={[styles.tierPriceSub, { color: colors.mutedForeground }]}>/ month</Text>
              </Text>
            )}
          </View>

          {PRO_FEATURES.map((f) => (
            <View key={f} style={styles.featureRow}>
              <Ionicons name="checkmark-circle" size={14} color={colors.primary} />
              <Text style={[styles.featureText, { color: colors.foreground }]}>{f}</Text>
            </View>
          ))}

          {configured ? (
            <TouchableOpacity
              onPress={handlePurchase}
              disabled={isPurchasing}
              activeOpacity={0.8}
              style={[styles.proCta, { backgroundColor: colors.primary, opacity: isPurchasing ? 0.7 : 1 }]}
            >
              {isPurchasing ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.proCtaText}>Start Free Trial</Text>
              )}
            </TouchableOpacity>
          ) : (
            <View style={[styles.proCta, { backgroundColor: colors.primary, opacity: 0.5 }]}>
              <Text style={styles.proCtaText}>Coming Soon</Text>
            </View>
          )}
        </View>

        {/* PREMIUM tier — Coming Soon */}
        <View style={[styles.tierCard, { backgroundColor: colors.card, borderColor: colors.border, opacity: 0.7 }]}>
          <View style={[styles.comingSoonBadge, { backgroundColor: colors.muted }]}>
            <Text style={[styles.comingSoonText, { color: colors.mutedForeground }]}>COMING SOON</Text>
          </View>

          <View style={styles.tierHeader}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Ionicons name="star" size={18} color={colors.mutedForeground} />
              <Text style={[styles.tierName, { color: colors.mutedForeground, fontFamily: 'Teko_700Bold' }]}>PREMIUM</Text>
            </View>
            <Text style={[styles.tierPrice, { color: colors.mutedForeground, fontFamily: 'Teko_700Bold' }]}>
              TBA
            </Text>
          </View>

          {PREMIUM_FEATURES.map((f) => (
            <View key={f} style={styles.featureRow}>
              <Ionicons name="checkmark-circle" size={14} color={colors.mutedForeground} />
              <Text style={[styles.featureText, { color: colors.mutedForeground }]}>{f}</Text>
            </View>
          ))}

          <View style={[styles.proCta, { backgroundColor: colors.muted }]}>
            <Text style={[styles.proCtaText, { color: colors.mutedForeground }]}>Notify Me</Text>
          </View>
        </View>

        <Text style={[styles.legal, { color: colors.mutedForeground }]}>
          No credit card surprises — cancel anytime from your billing page. Prices in USD.
        </Text>
      </ScrollView>

      {/* Restore */}
      <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>
        <TouchableOpacity onPress={handleRestore} disabled={isRestoring} style={styles.restoreBtn}>
          {isRestoring ? (
            <ActivityIndicator color={colors.mutedForeground} size="small" />
          ) : (
            <Text style={[styles.restoreText, { color: colors.mutedForeground }]}>
              Restore purchases
            </Text>
          )}
        </TouchableOpacity>
        <Text style={[styles.legalSmall, { color: colors.mutedForeground }]}>
          Subscriptions renew automatically. Cancel anytime in Settings.
        </Text>
      </View>
    </View>
  );
}

function makeStyles(colors: any, insets: any) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    content: {
      paddingTop: insets.top + (Platform.OS === 'web' ? 67 : 8),
      paddingHorizontal: 16,
      paddingBottom: 20,
      gap: 12,
    },
    closeBtn: { alignSelf: 'flex-end', padding: 4 },
    hero: { alignItems: 'center', paddingVertical: 8 },
    heroLogo: { width: 180, height: 42, marginBottom: 12 },
    heroTitle: {
      fontSize: 28,
      fontFamily: 'Teko_700Bold',
      color: colors.foreground,
      textAlign: 'center',
      marginBottom: 6,
      textTransform: 'uppercase',
      letterSpacing: 1,
    },
    heroSub: {
      fontSize: 14,
      color: colors.mutedForeground,
      textAlign: 'center',
      lineHeight: 20,
      fontFamily: 'Inter_400Regular',
    },
    tierCard: {
      borderRadius: 14,
      borderWidth: 1.5,
      padding: 16,
      gap: 8,
      position: 'relative',
    },
    proCard: {
      borderWidth: 2,
    },
    tierHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 4,
    },
    tierName: {
      fontSize: 22,
      letterSpacing: 1,
    },
    tierPrice: {
      fontSize: 24,
    },
    tierPriceSub: {
      fontSize: 14,
      fontFamily: 'Inter_400Regular',
    },
    featureRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 8,
    },
    featureText: {
      flex: 1,
      fontSize: 14,
      fontFamily: 'Inter_400Regular',
      lineHeight: 20,
    },
    freeCta: {
      marginTop: 8,
      height: 44,
      borderRadius: 10,
      borderWidth: 1,
      alignItems: 'center',
      justifyContent: 'center',
    },
    freeCtaText: {
      fontSize: 14,
      fontFamily: 'Inter_600SemiBold',
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    proCta: {
      marginTop: 8,
      height: 50,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
    },
    proCtaText: {
      fontSize: 16,
      fontFamily: 'Inter_700Bold',
      color: '#fff',
    },
    trialBadge: {
      position: 'absolute',
      top: -1,
      right: 16,
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderBottomLeftRadius: 8,
      borderBottomRightRadius: 8,
    },
    trialBadgeText: {
      fontSize: 10,
      fontFamily: 'Inter_700Bold',
      color: '#fff',
      letterSpacing: 0.5,
    },
    comingSoonBadge: {
      position: 'absolute',
      top: -1,
      right: 16,
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderBottomLeftRadius: 8,
      borderBottomRightRadius: 8,
    },
    comingSoonText: {
      fontSize: 10,
      fontFamily: 'Inter_700Bold',
      letterSpacing: 0.5,
    },
    footer: {
      paddingHorizontal: 20,
      paddingTop: 10,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      gap: 6,
      alignItems: 'center',
    },
    restoreBtn: { paddingVertical: 4 },
    restoreText: { fontSize: 14, fontFamily: 'Inter_400Regular' },
    legal: {
      fontSize: 12,
      textAlign: 'center',
      fontFamily: 'Inter_400Regular',
      lineHeight: 18,
      marginTop: 4,
    },
    legalSmall: {
      fontSize: 11,
      textAlign: 'center',
      fontFamily: 'Inter_400Regular',
      lineHeight: 16,
    },
  });
}
