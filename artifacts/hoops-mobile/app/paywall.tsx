import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
  Platform,
  Linking,
} from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useSubscription, PRO_ENTITLEMENT, PREMIUM_ENTITLEMENT } from '@/lib/revenuecat';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { tekoStyle } from '@/lib/tekoStyle';
import { Image } from 'expo-image';
import { useQueryClient } from '@tanstack/react-query';
import { getGetBillingStatusQueryKey } from '@workspace/api-client-react';

import { FREE_FEATURES, PRO_FEATURES, PREMIUM_FEATURES } from '@workspace/plan-copy';

export default function PaywallScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { offerings, purchase, restore, isPurchasing, isRestoring, isPro, isPremium, configured } =
    useSubscription();

  const [selectedPkg, setSelectedPkg] = useState<any | null>(null);
  const [billingPeriod, setBillingPeriod] = useState<'monthly' | 'annual'>('annual');
  const [isVerifying, setIsVerifying] = useState(false);

  // Keep a ref so the async verification loop can read the latest isPro value.
  const isProRef = useRef(isPro);
  useEffect(() => { isProRef.current = isPro; }, [isPro]);
  const currentOffering = offerings?.current;
  const packages = currentOffering?.availablePackages ?? [];

  // Separate monthly / annual packages from RevenueCat
  const monthlyPkg = packages.find((p: any) => p.packageType === '$rc_monthly') ?? packages[0] ?? null;
  const annualPkg  = packages.find((p: any) => p.packageType === '$rc_annual') ?? null;
  const hasAnnual  = !!annualPkg;

  // Pick active package based on toggle; default to annual when available
  const activePkg = hasAnnual && billingPeriod === 'annual' ? annualPkg : (monthlyPkg ?? packages[0] ?? null);

  // Derive the price string shown in the card
  const proPrice = activePkg?.product?.priceString ?? (billingPeriod === 'annual' ? '$59.99' : '$9.99');

  // Monthly equivalent for annual plan (annualPkg.product.price / 12)
  const annualMonthlyEquiv = (() => {
    const annualPrice = annualPkg?.product?.price;
    if (!annualPrice) return null;
    return `~$${(annualPrice / 12).toFixed(2)}`;
  })();
  const annualSavings = (() => {
    if (!annualPkg || !monthlyPkg) return null;
    const annual  = annualPkg?.product?.price ?? 0;
    const monthly = monthlyPkg?.product?.price ?? 0;
    if (!annual || !monthly) return null;
    const saved = Math.round((1 - annual / (monthly * 12)) * 100);
    return saved > 0 ? `Save ${saved}%` : null;
  })();

  // Pre-select on load; re-select when period changes
  useEffect(() => {
    if (activePkg) setSelectedPkg(activePkg);
  }, [billingPeriod, packages.length]);

  async function handlePurchase() {
    if (!selectedPkg) return;
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      await purchase(selectedPkg);
      // Invalidate the server-side billing status in parallel.
      queryClient.invalidateQueries({ queryKey: getGetBillingStatusQueryKey() });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      // Show a "Verifying your subscription…" overlay and wait for isPro to
      // flip to true (the cache was already seeded by onSuccess in revenuecat.tsx,
      // so this is usually instantaneous). Cap the wait at 2 s to avoid hanging.
      setIsVerifying(true);
      await new Promise<void>((resolve) => {
        const deadline = Date.now() + 2000;
        const tick = () => {
          if (isProRef.current || Date.now() >= deadline) {
            resolve();
          } else {
            setTimeout(tick, 50);
          }
        };
        tick();
      });

      router.back();
    } catch (err: any) {
      if (!err?.userCancelled) {
        Alert.alert('Purchase failed', err?.message ?? 'Please try again');
      }
    } finally {
      setIsVerifying(false);
    }
  }

  async function handleRestore() {
    try {
      const customerInfo = await restore();
      queryClient.invalidateQueries({ queryKey: getGetBillingStatusQueryKey() });
      const activeEntitlements = customerInfo?.entitlements.active ?? {};
      const isNowPro =
        PRO_ENTITLEMENT in activeEntitlements || PREMIUM_ENTITLEMENT in activeEntitlements;
      if (isNowPro) {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        Alert.alert('Purchases restored', 'Your Pro subscription has been restored.', [
          { text: 'OK', onPress: () => router.back() },
        ]);
      } else {
        Alert.alert(
          'No active subscription',
          'No active Pro subscription was found to restore.',
        );
      }
    } catch {
      Alert.alert('Restore failed', 'Unable to restore purchases. Please try again.');
    }
  }

  const styles = makeStyles(colors, insets);

  // proPrice and activePkg are derived above from billingPeriod state

  return (
    <View style={styles.root}>
      {/* Verifying overlay — shown briefly after a successful purchase while
          the entitlement cache propagates, so the coach never sees a Free flash. */}
      {isVerifying && (
        <View style={styles.verifyingOverlay}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={[styles.verifyingText, { color: colors.foreground }]}>
            Verifying your subscription…
          </Text>
        </View>
      )}

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
            <Text style={[styles.tierName, { color: colors.foreground }]}>FREE</Text>
            <Text style={[styles.tierPrice, { color: colors.foreground }]}>
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

        {/* Billing period toggle — only shown if RevenueCat has annual packages */}
        {hasAnnual && (
          <View style={[styles.periodToggle, { backgroundColor: colors.muted, borderColor: colors.border }]}>
            <TouchableOpacity
              onPress={() => setBillingPeriod('monthly')}
              style={[styles.periodBtn, billingPeriod === 'monthly' && { backgroundColor: colors.card }]}
              activeOpacity={0.8}
            >
              <Text style={[styles.periodBtnText, { color: billingPeriod === 'monthly' ? colors.foreground : colors.mutedForeground }]}>
                Monthly
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setBillingPeriod('annual')}
              style={[styles.periodBtn, billingPeriod === 'annual' && { backgroundColor: colors.card }]}
              activeOpacity={0.8}
            >
              <Text style={[styles.periodBtnText, { color: billingPeriod === 'annual' ? colors.foreground : colors.mutedForeground }]}>
                Annual
              </Text>
              {annualSavings && (
                <View style={[styles.savingsBadge, { backgroundColor: colors.primary }]}>
                  <Text style={styles.savingsBadgeText}>{annualSavings}</Text>
                </View>
              )}
            </TouchableOpacity>
          </View>
        )}

        {/* PRO tier */}
        <View style={[styles.tierCard, styles.proCard, { backgroundColor: colors.card, borderColor: colors.primary }]}>
          {/* Badge */}
          <View style={[styles.trialBadge, { backgroundColor: colors.primary }]}>
            <Text style={styles.trialBadgeText}>14-DAY FREE TRIAL</Text>
          </View>

          <View style={styles.tierHeader}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Ionicons name="flash" size={18} color={colors.primary} />
              <Text style={[styles.tierName, { color: colors.primary }]}>PRO</Text>
            </View>
            {configured ? (
              billingPeriod === 'annual' && annualMonthlyEquiv ? (
                <Text style={[styles.tierPriceSub, { color: colors.mutedForeground, textAlign: 'right' }]}>
                  <Text style={[styles.tierPrice, { color: colors.foreground }]}>{annualMonthlyEquiv}</Text>
                  {' / mo\n'}
                  <Text style={{ fontSize: 12 }}>{proPrice} billed annually</Text>
                </Text>
              ) : (
                <Text style={[styles.tierPrice, { color: colors.foreground }]}>
                  {proPrice}{' '}
                  <Text style={[styles.tierPriceSub, { color: colors.mutedForeground }]}>
                    / month
                  </Text>
                </Text>
              )
            ) : (
              <Text style={[styles.tierPrice, { color: colors.foreground }]}>
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
            <View style={{ gap: 4 }}>
              <View style={[styles.proCta, { backgroundColor: colors.muted, opacity: 0.8 }]}>
                <Text style={[styles.proCtaText, { color: colors.mutedForeground }]}>
                  Subscriptions Unavailable
                </Text>
              </View>
              <Text style={[styles.unconfiguredNote, { color: colors.mutedForeground }]}>
                In-app purchases are not configured for this build. Please contact support.
              </Text>
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
              <Text style={[styles.tierName, { color: colors.mutedForeground }]}>PREMIUM</Text>
            </View>
            <Text style={[styles.tierPrice, { color: colors.mutedForeground }]}>
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

        {/* Required Apple subscription disclosure */}
        <Text style={[styles.legal, { color: colors.mutedForeground }]}>
          Payment charged to your Apple ID at purchase confirmation. Subscription auto-renews
          unless cancelled at least 24 hours before the end of the current period. Manage or
          cancel in your Apple ID Account Settings.
        </Text>

        {/* Privacy Policy + Terms links */}
        <View style={styles.legalLinks}>
          <TouchableOpacity
            onPress={() => {
              const domain = process.env.EXPO_PUBLIC_DOMAIN ?? 'stecstats.com';
              WebBrowser.openBrowserAsync(`https://${domain}/privacy`);
            }}
          >
            <Text style={[styles.legalLink, { color: colors.mutedForeground }]}>Privacy Policy</Text>
          </TouchableOpacity>
          <Text style={[styles.legalLinkSep, { color: colors.mutedForeground }]}>·</Text>
          <TouchableOpacity
            onPress={() => {
              const domain = process.env.EXPO_PUBLIC_DOMAIN ?? 'stecstats.com';
              WebBrowser.openBrowserAsync(`https://${domain}/terms`);
            }}
          >
            <Text style={[styles.legalLink, { color: colors.mutedForeground }]}>Terms of Use</Text>
          </TouchableOpacity>
        </View>
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
      ...tekoStyle(28),
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
      ...tekoStyle(22),
      letterSpacing: 1,
    },
    tierPrice: {
      ...tekoStyle(24),
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
    unconfiguredNote: {
      fontSize: 12,
      textAlign: 'center',
      fontFamily: 'Inter_400Regular',
      lineHeight: 17,
    },
    verifyingOverlay: {
      ...StyleSheet.absoluteFillObject,
      zIndex: 100,
      backgroundColor: 'rgba(0,0,0,0.6)',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 16,
    },
    verifyingText: {
      fontSize: 16,
      fontFamily: 'Inter_600SemiBold',
      textAlign: 'center',
    },
    periodToggle: {
      flexDirection: 'row',
      borderRadius: 12,
      borderWidth: 1,
      padding: 4,
      gap: 4,
    },
    periodBtn: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      paddingVertical: 10,
      borderRadius: 9,
    },
    periodBtnText: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
    savingsBadge: {
      paddingHorizontal: 7,
      paddingVertical: 2,
      borderRadius: 6,
    },
    savingsBadgeText: { fontSize: 10, fontFamily: 'Inter_700Bold', color: '#fff' },
    legalLinks: {
      flexDirection: 'row',
      justifyContent: 'center',
      alignItems: 'center',
      gap: 8,
      marginTop: 2,
    },
    legalLink: {
      fontSize: 12,
      fontFamily: 'Inter_400Regular',
      textDecorationLine: 'underline',
    },
    legalLinkSep: {
      fontSize: 12,
      fontFamily: 'Inter_400Regular',
    },
  });
}
