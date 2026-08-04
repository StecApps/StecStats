import React, { useEffect, useRef } from 'react';
import { Alert } from 'react-native';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
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
import { useFonts } from 'expo-font';
import { Stack, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import * as SystemUI from 'expo-system-ui';
import { ClerkProvider, useAuth } from '@clerk/clerk-expo';
import * as SecureStore from 'expo-secure-store';
import { setBaseUrl, setAuthTokenGetter, useUpdatePlayer, getListPlayersQueryKey } from '@workspace/api-client-react';
import { SubscriptionProvider, initializeRevenueCat, loginRevenueCat, logoutRevenueCat } from '@/lib/revenuecat';
import { getPendingPhotos, dequeuePhoto } from '@/lib/pendingPhotoQueue';
import { uploadPhoto } from '@/lib/photoUpload';

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
  const { getToken, isSignedIn, userId } = useAuth();

  useEffect(() => {
    setAuthTokenGetter(async () => {
      if (!isSignedIn) return null;
      return (await getToken()) ?? null;
    });
  }, [isSignedIn, getToken]);

  // Link the RevenueCat subscriber to the Clerk user so that server-side
  // RC webhooks can update the correct user row via app_user_id = clerkUserId.
  useEffect(() => {
    if (isSignedIn && userId) {
      loginRevenueCat(userId);
    } else if (!isSignedIn) {
      logoutRevenueCat();
    }
  }, [isSignedIn, userId]);

  return null;
}

/**
 * On every app open, silently retries any photo uploads that failed last session.
 * Runs only when the user is signed in so we have a valid auth token.
 * On failure keeps the entry in the queue; shows a single alert listing how many
 * photos still couldn't be uploaded so the coach knows to try again.
 */
function PendingPhotoRetry() {
  const { isSignedIn, getToken } = useAuth();
  const updatePlayer = useUpdatePlayer();
  const qc = useQueryClient();
  const hasRun = useRef(false);

  useEffect(() => {
    if (!isSignedIn || hasRun.current) return;
    hasRun.current = true;

    (async () => {
      const pending = await getPendingPhotos();
      if (pending.length === 0) return;

      let failCount = 0;
      for (const entry of pending) {
        try {
          const token = await getToken();
          if (!token) {
            failCount += pending.length;
            break;
          }
          const objectPath = await uploadPhoto(entry.uri, entry.mimeType, token);
          await updatePlayer.mutateAsync({
            playerId: entry.playerId,
            data: { photoObjectPath: objectPath },
          });
          qc.invalidateQueries({ queryKey: getListPlayersQueryKey() });
          await dequeuePhoto(entry.id);
        } catch {
          failCount++;
        }
      }

      if (failCount > 0) {
        Alert.alert(
          'Photo upload incomplete',
          `${failCount} player photo${failCount > 1 ? 's' : ''} couldn't be uploaded. Open the player's profile and tap their photo to try again.`,
          [{ text: 'OK' }],
        );
      }
    })();
  }, [isSignedIn]);

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
