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

const FEATURES = [
  { icon: 'stats-chart', label: 'Career stats & season history', pro: true },
  { icon: 'analytics', label: 'Shooting percentage analytics', pro: true },
  { icon: 'videocam', label: 'HD game video recording', pro: true },
  { icon: 'film', label: 'AI-generated highlight reels', pro: true },
  { icon: 'radio', label: 'Live stream to fans & family', pro: false },
  { icon: 'star', label: 'Unlimited teams & players', pro: false },
];

export default function PaywallScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
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
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert('Purchases restored', 'Your subscription has been restored.');
      router.back();
    } catch {
      Alert.alert('Restore failed', 'No purchases found to restore.');
    }
  }

  const styles = makeStyles(colors, insets);

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
          <View style={[styles.heroBadge, { backgroundColor: colors.primary + '20' }]}>
            <Ionicons name="flash" size={32} color={colors.primary} />
          </View>
          <Text style={styles.heroTitle}>Unlock the Full Playbook</Text>
          <Text style={styles.heroSub}>
            Everything you need to coach smarter — stats, video, and highlights.
          </Text>
        </View>

        {/* Feature list */}
        <View style={styles.featureList}>
          {FEATURES.map((f) => (
            <View key={f.label} style={styles.featureRow}>
              <View style={[styles.featureIcon, { backgroundColor: colors.primary + '15' }]}>
                <Ionicons name={f.icon as any} size={16} color={colors.primary} />
              </View>
              <Text style={[styles.featureText, { color: colors.foreground }]}>{f.label}</Text>
              <Ionicons name="checkmark-circle" size={18} color={colors.primary} />
            </View>
          ))}
        </View>

        {/* Plans */}
        {!configured ? (
          <View style={[styles.noPlansCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Ionicons name="construct-outline" size={28} color={colors.mutedForeground} />
            <Text style={[styles.noPlansText, { color: colors.mutedForeground }]}>
              Subscription plans coming soon. Contact your coach admin to upgrade.
            </Text>
          </View>
        ) : packages.length === 0 ? (
          <ActivityIndicator color={colors.primary} style={{ marginVertical: 24 }} />
        ) : (
          packages.map((pkg: any) => {
            const isSelected = selectedPkg?.identifier === pkg.identifier;
            return (
              <TouchableOpacity
                key={pkg.identifier}
                onPress={() => setSelectedPkg(pkg)}
                activeOpacity={0.7}
                style={[
                  styles.planCard,
                  {
                    backgroundColor: isSelected ? colors.primary + '10' : colors.card,
                    borderColor: isSelected ? colors.primary : colors.border,
                  },
                ]}
              >
                <View style={styles.planRadio}>
                  <Ionicons
                    name={isSelected ? 'radio-button-on' : 'radio-button-off'}
                    size={20}
                    color={isSelected ? colors.primary : colors.mutedForeground}
                  />
                </View>
                <View style={styles.planInfo}>
                  <Text style={[styles.planTitle, { color: colors.foreground }]}>
                    {pkg.product.title || pkg.identifier}
                  </Text>
                  <Text style={[styles.planDesc, { color: colors.mutedForeground }]}>
                    {pkg.product.description || 'Full access to all features'}
                  </Text>
                </View>
                <Text style={[styles.planPrice, { color: colors.primary, fontFamily: 'Teko_700Bold' }]}>
                  {pkg.product.priceString}
                </Text>
              </TouchableOpacity>
            );
          })
        )}
      </ScrollView>

      {/* CTA */}
      <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>
        {configured && (
          <TouchableOpacity
            onPress={handlePurchase}
            disabled={!selectedPkg || isPurchasing}
            activeOpacity={0.8}
            style={[
              styles.ctaBtn,
              { backgroundColor: colors.primary, opacity: !selectedPkg || isPurchasing ? 0.5 : 1 },
            ]}
          >
            {isPurchasing ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.ctaText}>
                {selectedPkg
                  ? `Subscribe · ${selectedPkg.product.priceString}`
                  : 'Select a plan'}
              </Text>
            )}
          </TouchableOpacity>
        )}

        <TouchableOpacity onPress={handleRestore} disabled={isRestoring} style={styles.restoreBtn}>
          {isRestoring ? (
            <ActivityIndicator color={colors.mutedForeground} size="small" />
          ) : (
            <Text style={[styles.restoreText, { color: colors.mutedForeground }]}>
              Restore purchases
            </Text>
          )}
        </TouchableOpacity>

        <Text style={[styles.legal, { color: colors.mutedForeground }]}>
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
      paddingHorizontal: 20,
      paddingBottom: 20,
    },
    closeBtn: { alignSelf: 'flex-end', padding: 4, marginBottom: 8 },
    hero: { alignItems: 'center', paddingBottom: 24 },
    heroBadge: {
      width: 72,
      height: 72,
      borderRadius: 20,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 14,
    },
    heroTitle: {
      fontSize: 24,
      fontFamily: 'Inter_700Bold',
      color: colors.foreground,
      textAlign: 'center',
      marginBottom: 8,
    },
    heroSub: {
      fontSize: 15,
      color: colors.mutedForeground,
      textAlign: 'center',
      lineHeight: 22,
      fontFamily: 'Inter_400Regular',
    },
    featureList: {
      gap: 10,
      marginBottom: 24,
    },
    featureRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
    },
    featureIcon: {
      width: 32,
      height: 32,
      borderRadius: 8,
      alignItems: 'center',
      justifyContent: 'center',
    },
    featureText: { flex: 1, fontSize: 15, fontFamily: 'Inter_500Medium' },
    noPlansCard: {
      borderRadius: 12,
      borderWidth: 1,
      padding: 20,
      alignItems: 'center',
      gap: 10,
      marginBottom: 16,
    },
    noPlansText: {
      fontSize: 14,
      fontFamily: 'Inter_400Regular',
      textAlign: 'center',
      lineHeight: 20,
    },
    planCard: {
      flexDirection: 'row',
      alignItems: 'center',
      borderRadius: 12,
      borderWidth: 2,
      padding: 14,
      marginBottom: 10,
      gap: 12,
    },
    planRadio: {},
    planInfo: { flex: 1 },
    planTitle: { fontSize: 16, fontFamily: 'Inter_600SemiBold', marginBottom: 2 },
    planDesc: { fontSize: 13, fontFamily: 'Inter_400Regular' },
    planPrice: { fontSize: 22, lineHeight: 24 },
    footer: {
      paddingHorizontal: 20,
      paddingTop: 12,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      gap: 10,
    },
    ctaBtn: {
      height: 54,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
    },
    ctaText: { fontSize: 17, fontFamily: 'Inter_700Bold', color: '#fff' },
    restoreBtn: { alignItems: 'center', paddingVertical: 4 },
    restoreText: { fontSize: 14, fontFamily: 'Inter_400Regular' },
    legal: {
      fontSize: 11,
      textAlign: 'center',
      fontFamily: 'Inter_400Regular',
      lineHeight: 16,
    },
  });
}
