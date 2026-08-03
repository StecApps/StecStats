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

function getRevenueCatApiKey(): string | null {
  if (!REVENUECAT_TEST_API_KEY || !REVENUECAT_IOS_API_KEY || !REVENUECAT_ANDROID_API_KEY) {
    return null;
  }
  if (__DEV__ || Platform.OS === 'web' || Constants.executionEnvironment === 'storeClient') {
    return REVENUECAT_TEST_API_KEY;
  }
  if (Platform.OS === 'ios') return REVENUECAT_IOS_API_KEY;
  if (Platform.OS === 'android') return REVENUECAT_ANDROID_API_KEY;
  return REVENUECAT_TEST_API_KEY;
}

export function initializeRevenueCat() {
  const apiKey = getRevenueCatApiKey();
  if (!apiKey) {
    console.warn('[RevenueCat] API keys not set — subscription features unavailable until configured.');
    return;
  }
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
