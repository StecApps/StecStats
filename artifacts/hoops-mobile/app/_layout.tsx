import React, { useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from '@expo-google-fonts/inter';
import {
  Teko_400Regular,
  Teko_600SemiBold,
  Teko_700Bold,
} from '@expo-google-fonts/teko';
// ⚠️  TEKO LINE-HEIGHT RULE: every Text node using Teko_600SemiBold or
// Teko_700Bold MUST set lineHeight ≥ fontSize × 1.3 in its StyleSheet.
// Without this, Teko's tall cap-height causes digit tops (0–9) to be clipped
// on iOS — the default React Native lineHeight is too tight for this typeface.
// Example: fontSize 30 → lineHeight must be at least 39.
// Run a visual check on iPhone 14 Pro simulator after adding any new Teko node.
import { useFonts } from 'expo-font';
import { Stack, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import * as SystemUI from 'expo-system-ui';
import { ClerkProvider, useAuth } from '@clerk/clerk-expo';
import * as SecureStore from 'expo-secure-store';
import { setBaseUrl, setAuthTokenGetter } from '@workspace/api-client-react';
import { SubscriptionProvider, initializeRevenueCat } from '@/lib/revenuecat';
import { useRevenueCatAuthSync } from '@/lib/useRevenueCatAuthSync';
import { PendingPhotoRetry } from '@/components/PendingPhotoRetry';

SplashScreen.preventAutoHideAsync();

// Set the API base URL at module level — Expo bundles run outside the proxy
// and need an absolute URL to reach the API server.
if (process.env.EXPO_PUBLIC_DOMAIN) {
  setBaseUrl(`https://${process.env.EXPO_PUBLIC_DOMAIN}`);
}

// Initialize RevenueCat (gracefully no-ops if keys aren't set yet).
try {
  initializeRevenueCat();
} catch (err: any) {
  console.warn('[RevenueCat]', err?.message ?? 'Init failed');
}

// Clerk token cache backed by SecureStore so sessions persist across restarts.
const tokenCache = {
  async getToken(key: string) {
    return SecureStore.getItemAsync(key);
  },
  async saveToken(key: string, value: string) {
    return SecureStore.setItemAsync(key, value);
  },
  async clearToken(key: string) {
    return SecureStore.deleteItemAsync(key);
  },
};

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
});

/** Wires the Clerk session token into the shared API client fetch layer. */
function ApiAuthSetup() {
  const { getToken, isSignedIn, isLoaded, userId } = useAuth();

  // Register the token getter once — don't close over isSignedIn because
  // the stale closure value can make the getter return null even after the
  // user is signed in. getToken() returns null naturally when there is no
  // active session, so the isSignedIn guard is redundant and harmful.
  useEffect(() => {
    setAuthTokenGetter(() => getToken());
  }, [getToken]);

  // When auth becomes ready, clear the entire query cache so pre-auth 401
  // errors don't survive sign-in. `invalidateQueries()` only marks successful
  // cache entries as stale — it does NOT remove error entries, which React
  // Query treats differently (errors are not subject to staleTime). On a fresh
  // install a query can fire before Clerk settles, get retried once (retry:1),
  // and then the 401 error is cached. That error survives invalidation and
  // blocks the re-fetch even after a valid token is available.
  //
  // `queryClient.clear()` removes every cache entry — both data and errors —
  // so any component that is still mounted will immediately re-fetch with the
  // fresh Clerk token. This is safe on sign-in because there is no useful
  // pre-auth cached data to preserve.
  useEffect(() => {
    if (isSignedIn) {
      queryClient.clear();
    }
  }, [isSignedIn]);

  // Sync RevenueCat subscriber identity with Clerk — guarded on isLoaded so
  // the transient reload state (isLoaded=false, isSignedIn=false) is never
  // mistaken for a deliberate sign-out. See lib/useRevenueCatAuthSync.ts.
  useRevenueCatAuthSync({ isLoaded, isSignedIn, userId });

  return null;
}

/** Redirects unauthenticated users to the auth screen and vice-versa. */
function AuthGate() {
  const { isSignedIn, isLoaded } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (!isLoaded) return;
    const inAuth = segments[0] === '(auth)';
    if (!isSignedIn && !inAuth) {
      router.replace('/(auth)');
    } else if (isSignedIn && inAuth) {
      router.replace('/(tabs)');
    }
  }, [isSignedIn, isLoaded, segments, router]);

  return null;
}

function RootLayoutNav() {
  return (
    <>
      <ApiAuthSetup />
      <AuthGate />
      <PendingPhotoRetry />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(auth)" options={{ animation: 'none' }} />
        <Stack.Screen name="(tabs)" options={{ animation: 'none' }} />
        <Stack.Screen
          name="scorekeeper"
          options={{ presentation: 'fullScreenModal', animation: 'slide_from_bottom' }}
        />
        <Stack.Screen
          name="game/[id]"
          options={{ presentation: 'card', headerShown: true, title: '', headerBackTitle: 'Games' }}
        />
        <Stack.Screen
          name="paywall"
          options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
        />
      </Stack>
    </>
  );
}

const PUBLISHABLE_KEY = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ?? '';

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    Teko_400Regular,
    Teko_600SemiBold,
    Teko_700Bold,
  });

  useEffect(() => {
    SystemUI.setBackgroundColorAsync('#0C0A09');
  }, []);

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <ClerkProvider publishableKey={PUBLISHABLE_KEY} tokenCache={tokenCache}>
      <SafeAreaProvider>
        <ErrorBoundary>
          <QueryClientProvider client={queryClient}>
            <SubscriptionProvider>
              <GestureHandlerRootView style={{ flex: 1 }}>
                <KeyboardProvider>
                  <RootLayoutNav />
                </KeyboardProvider>
              </GestureHandlerRootView>
            </SubscriptionProvider>
          </QueryClientProvider>
        </ErrorBoundary>
      </SafeAreaProvider>
    </ClerkProvider>
  );
}
