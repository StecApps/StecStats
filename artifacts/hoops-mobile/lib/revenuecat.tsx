import React, { createContext, useContext } from 'react';
import { Platform } from 'react-native';
import Purchases from 'react-native-purchases';
import { useMutation, useQuery } from '@tanstack/react-query';
import Constants from 'expo-constants';

const REVENUECAT_TEST_API_KEY = process.env.EXPO_PUBLIC_REVENUECAT_TEST_API_KEY;
const REVENUECAT_IOS_API_KEY = process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY;
const REVENUECAT_ANDROID_API_KEY = process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY;

// Entitlement identifiers — must match what the seed script creates.
export const PRO_ENTITLEMENT = 'pro';
export const PREMIUM_ENTITLEMENT = 'premium';

interface RevenueCatKeyResult {
  key: string | null;
  /** Human-readable source label (never includes the key value). */
  source: string;
}

function getRevenueCatApiKeyWithSource(): RevenueCatKeyResult {
  // Dev mode (Expo Go, simulator, web preview) — only the test key is needed.
  if (__DEV__ || Platform.OS === 'web' || Constants.executionEnvironment === 'storeClient') {
    if (!REVENUECAT_TEST_API_KEY) {
      return { key: null, source: 'development — EXPO_PUBLIC_REVENUECAT_TEST_API_KEY not set' };
    }
    return { key: REVENUECAT_TEST_API_KEY, source: 'development / Expo Go (EXPO_PUBLIC_REVENUECAT_TEST_API_KEY)' };
  }

  // Production iOS build — only the iOS key is required.
  if (Platform.OS === 'ios') {
    if (!REVENUECAT_IOS_API_KEY) {
      return { key: null, source: 'production iOS — EXPO_PUBLIC_REVENUECAT_IOS_API_KEY not set' };
    }
    return { key: REVENUECAT_IOS_API_KEY, source: 'production iOS (EXPO_PUBLIC_REVENUECAT_IOS_API_KEY)' };
  }

  // Production Android build — only the Android key is required.
  if (Platform.OS === 'android') {
    if (!REVENUECAT_ANDROID_API_KEY) {
      return { key: null, source: 'production Android — EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY not set' };
    }
    return { key: REVENUECAT_ANDROID_API_KEY, source: 'production Android (EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY)' };
  }

  // Unknown platform fallback.
  if (!REVENUECAT_TEST_API_KEY) {
    return { key: null, source: 'unknown platform — no RevenueCat API key available' };
  }
  return { key: REVENUECAT_TEST_API_KEY, source: 'unknown platform fallback (EXPO_PUBLIC_REVENUECAT_TEST_API_KEY)' };
}

function getRevenueCatApiKey(): string | null {
  return getRevenueCatApiKeyWithSource().key;
}

export function initializeRevenueCat() {
  const { key: apiKey, source } = getRevenueCatApiKeyWithSource();
  if (!apiKey) {
    console.warn(`[RevenueCat] Key path: ${source} — subscription features unavailable until configured.`);
    return;
  }
  console.log(`[RevenueCat] Key path: ${source}`);
  Purchases.setLogLevel(Purchases.LOG_LEVEL.WARN);
  Purchases.configure({ apiKey });
}

/**
 * Associates the RevenueCat subscriber with the signed-in Clerk user.
 * Must be called after sign-in so that server-side webhooks can map RC events
 * back to the correct user row via `app_user_id` = Clerk user ID.
 */
export async function loginRevenueCat(clerkUserId: string): Promise<void> {
  if (!getRevenueCatApiKey()) return;
  try {
    await Purchases.logIn(clerkUserId);
  } catch (err: any) {
    console.warn('[RevenueCat] logIn failed:', err?.message ?? err);
  }
}

/**
 * Unlinks the RevenueCat subscriber when the user signs out.
 * This resets to an anonymous RC user so the next person who signs in
 * on the same device gets a clean state.
 */
export async function logoutRevenueCat(): Promise<void> {
  if (!getRevenueCatApiKey()) return;
  try {
    await Purchases.logOut();
  } catch (err: any) {
    console.warn('[RevenueCat] logOut failed:', err?.message ?? err);
  }
}

function useSubscriptionContext() {
  const configured = !!getRevenueCatApiKey();

  const customerInfoQuery = useQuery({
    queryKey: ['revenuecat', 'customer-info'],
    queryFn: async () => {
      if (!configured) return null;
      return Purchases.getCustomerInfo();
    },
    staleTime: 60 * 1000,
  });

  const offeringsQuery = useQuery({
    queryKey: ['revenuecat', 'offerings'],
    queryFn: async () => {
      if (!configured) return null;
      return Purchases.getOfferings();
    },
    staleTime: 300 * 1000,
  });

  const purchaseMutation = useMutation({
    mutationFn: async (packageToPurchase: any) => {
      const { customerInfo } = await Purchases.purchasePackage(packageToPurchase);
      return customerInfo;
    },
    onSuccess: () => customerInfoQuery.refetch(),
  });

  const restoreMutation = useMutation({
    mutationFn: async () => Purchases.restorePurchases(),
    onSuccess: () => customerInfoQuery.refetch(),
  });

  const entitlements = customerInfoQuery.data?.entitlements.active ?? {};
  const isPro = PRO_ENTITLEMENT in entitlements || PREMIUM_ENTITLEMENT in entitlements;
  const isPremium = PREMIUM_ENTITLEMENT in entitlements;

  return {
    customerInfo: customerInfoQuery.data,
    offerings: offeringsQuery.data,
    isPro,
    isPremium,
    isSubscribed: isPro,
    isLoading: customerInfoQuery.isLoading || offeringsQuery.isLoading,
    purchase: purchaseMutation.mutateAsync,
    restore: restoreMutation.mutateAsync,
    isPurchasing: purchaseMutation.isPending,
    isRestoring: restoreMutation.isPending,
    configured,
  };
}

type SubscriptionContextValue = ReturnType<typeof useSubscriptionContext>;
const Context = createContext<SubscriptionContextValue | null>(null);

export function SubscriptionProvider({ children }: { children: React.ReactNode }) {
  const value = useSubscriptionContext();
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useSubscription() {
  const ctx = useContext(Context);
  if (!ctx) throw new Error('useSubscription must be used within SubscriptionProvider');
  return ctx;
}
