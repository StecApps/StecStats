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
import { SubscriptionProvider, initializeRevenueCat, loginRevenueCat, logoutRevenueCat } from '@/lib/revenuecat';
import { clearPendingPhotos } from '@/lib/pendingPhotoQueue';
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

  useEffect(() => {
    setAuthTokenGetter(async () => {
      if (!isSignedIn) return null;
      return (await getToken()) ?? null;
    });
  }, [isSignedIn, getToken]);

  // Link the RevenueCat subscriber to the Clerk user so that server-side
  // RC webhooks can update the correct user row via app_user_id = clerkUserId.
  // On sign-out, also clear this coach's pending photo queue so a different
  // coach signing in on the same device never retries the wrong uploads.
  //
  // IMPORTANT: guard on `isLoaded` before calling logoutRevenueCat().
  // On app reload / Metro bundler restart, Clerk starts with isSignedIn=false
  // while it restores the session from SecureStore. Calling logOut() during
  // that transient window would log RC out unnecessarily — and in Expo Go's
  // "Browser Mode" the call throws "Unknown backend error", which could
  // corrupt RC state before loginRevenueCat() fires a moment later.
  const prevUserIdRef = React.useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!isLoaded) return; // wait until Clerk has fully restored the session

    if (isSignedIn && userId) {
      loginRevenueCat(userId);
    } else if (!isSignedIn) {
      // Only reach here for a deliberate sign-out, not a transient reload state.
      logoutRevenueCat();
      // Clear the queue for the coach who just signed out.
      const prev = prevUserIdRef.current;
      if (prev) {
        clearPendingPhotos(prev).catch(() => {});
      }
    }
    prevUserIdRef.current = userId;
  }, [isLoaded, isSignedIn, userId]);

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
