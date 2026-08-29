import React, { useEffect } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import * as Updates from 'expo-updates';
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
import { useOfflineQueueSync } from '@/lib/useOfflineQueueSync';

SplashScreen.preventAutoHideAsync();
import { Alert, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';

/**
 * OTA update strategy — ON_LOAD with a mandatory reload prompt.
 *
 * Why ON_LOAD (not background / next-launch):
 *   The default expo-updates behaviour downloads an update silently and only
 *   applies it on the *next* launch. If the coach force-quits the app while
 *   the download is in progress the partial state can leave them on an old
 *   version indefinitely. Checking and applying synchronously at startup
 *   (before the main UI appears) eliminates that window.
 *
 * Tradeoff vs. background strategy:
 *   Background: zero friction — coaches never see a prompt; update applies
 *     on the next natural relaunch. Appropriate for non-critical style/copy
 *     changes that ship frequently.
 *   ON_LOAD mandatory (this implementation): adds a one-time ~1-3 s pause
 *     at startup when a new update is waiting. Appropriate for critical bug
 *     fixes (scoring logic, video saves, payment flows) where being one
 *     version behind causes data loss or broken features.
 *
 * To switch to background-only for a lower-urgency release cadence, replace
 * the body of useOTAUpdate with a no-op and re-enable expo-updates' built-in
 * checkAutomatically: "ON_LOAD" in app.json (default behaviour).
 *
 * Updates.isEnabled is false in Expo Go and bare dev builds, so this hook
 * silently no-ops during local development.
 */
async function checkAndApplyUpdate(): Promise<void> {
  if (!Updates.isEnabled) return;
  try {
    const result = await Updates.checkForUpdateAsync();
    if (!result.isAvailable) return;
    await Updates.fetchUpdateAsync();
    await new Promise<void>((resolve) => {
      Alert.alert(
        'Update Ready',
        'A critical update has been downloaded. The app will reload now to apply it.',
        [{ text: 'Reload', onPress: () => resolve() }],
        { cancelable: false },
      );
    });
    await Updates.reloadAsync();
  } catch (err) {
    // Non-fatal: network errors, invalid manifest, etc. Coach continues on
    // the current version and will catch the update on the next launch.
    console.warn('[OTA] Update check failed:', err);
  }
}

function useOTAUpdate() {
  useEffect(() => {
    checkAndApplyUpdate();
  }, []);
}

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
  defaultOptions: {
    queries: {
      // Short-circuit retries for auth errors so that 401/403 responses fired
      // during the Clerk loading window don't get retried and cached as errors.
      // Once Clerk settles and the user signs in, `queryClient.clear()` (above)
      // removes those error entries and components re-fetch with a valid token.
      // Non-auth errors (network flakes, 5xx) still get one retry as before.
      retry: (failureCount, error: any) => {
        const status = error?.status ?? error?.response?.status;
        if (status === 401 || status === 403) return false;
        return failureCount < 1;
      },
      staleTime: 30_000,
    },
  },
});

/**
 * Wires the Clerk session token into the shared API client fetch layer.
 *
 * Exported so integration tests can render this component directly inside a
 * QueryClientProvider and spy on the QueryClient it receives from context.
 */
export function ApiAuthSetup() {
  const { getToken, isSignedIn, isLoaded, userId } = useAuth();
  // Read the QueryClient from context so tests can inject a spy instance via
  // QueryClientProvider — without this the component closes over the
  // module-level queryClient which is unreachable from outside the module.
  const qc = useQueryClient();

  // Register the token getter once — don't close over isSignedIn because
  // the stale closure value can make the getter return null even after the
  // user is signed in. getToken() returns null naturally when there is no
  // active session, so the isSignedIn guard is redundant and harmful.
  useEffect(() => {
    setAuthTokenGetter(() => getToken());
  }, [getToken]);

  // When auth becomes ready, reset all queries so pre-auth 401 error entries
  // are removed and active (mounted) query observers immediately re-fetch with
  // the fresh Clerk token — no pull-to-refresh required.
  //
  // resetQueries() is preferred over clear() because it notifies active
  // observers so they re-fetch inline, whereas clear() destroys observers and
  // leaves mounted screens empty until their next render cycle.
  //
  // It is preferred over invalidateQueries() because invalidation does not
  // remove error entries from the cache — a cached 401 error persists and
  // blocks the re-fetch even after a valid token is available.
  //
  // IMPORTANT: we await getToken() before calling resetQueries() so the
  // re-fetches only fire once the token is actually available. Without this,
  // resetQueries() can trigger re-fetches during a token refresh (which takes
  // ~600ms), causing those requests to also go out with no Authorization
  // header and get cached as 401 errors again.
  useEffect(() => {
    if (!isSignedIn) return;
    let cancelled = false;
    getToken().then((token) => {
      if (!cancelled && token) {
        qc.resetQueries();
      }
    });
    return () => { cancelled = true; };
  }, [isSignedIn, qc, getToken]);

  // Sync RevenueCat subscriber identity with Clerk — guarded on isLoaded so
  // the transient reload state (isLoaded=false, isSignedIn=false) is never
  // mistaken for a deliberate sign-out. See lib/useRevenueCatAuthSync.ts.
  useRevenueCatAuthSync({ isLoaded, isSignedIn, userId });

  // Flush offline-queued games whenever connectivity returns or the app
  // comes to the foreground — survives scorekeeper unmount/navigation.
  const apiBase = process.env.EXPO_PUBLIC_DOMAIN
    ? `https://${process.env.EXPO_PUBLIC_DOMAIN}`
    : '';
  useOfflineQueueSync(apiBase);

  return null;
}

async function ensureHighlightChannel() {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync('highlights', {
    name: 'Highlights Ready',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 250, 250],
  });
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
      <PushNotificationSetup />
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
// Route Clerk API calls through our own proxy so mobile auth works even if the
// clerk.stecstats.stecco.org custom-domain DNS record is not yet propagated.
// The proxy is live at /api/__clerk on the API server and forwards to
// frontend-api.clerk.dev, so Clerk SDK calls work regardless of DNS state.
const CLERK_PROXY_URL = process.env.EXPO_PUBLIC_CLERK_PROXY_URL;

export default function RootLayout() {
  useOTAUpdate();

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
    <ClerkProvider publishableKey={PUBLISHABLE_KEY} tokenCache={tokenCache} {...(CLERK_PROXY_URL ? { proxyUrl: CLERK_PROXY_URL } : {})}>
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

/**
 * Requests push notification permission once the coach is signed in, obtains
 * the Expo push token, and registers it with the API server so the server can
 * send notifications (e.g. "Your highlights are ready 🏀").
 *
 * Also handles notification taps — tapping a game highlight/lowlight
 * notification navigates directly to that game's film room; tapping a season
 * reel notification falls back to the Games tab.
 */
function PushNotificationSetup() {
  // expo-notifications does not implement useLastNotificationResponse on web.
  // Keep the web preview usable for reviewer/auth flow checks while retaining
  // the full notification behavior in native iOS and Android builds.
  if (Platform.OS === 'web') return null;

  return <NativePushNotificationSetup />;
}

function NativePushNotificationSetup() {
  const { getToken, isSignedIn } = useAuth();
  const router = useRouter();

  // Deep-link when the coach taps a notification.
  const lastResponse = Notifications.useLastNotificationResponse();
  useEffect(() => {
    if (!lastResponse) return;
    const data = lastResponse.notification.request.content.data as
      | Record<string, unknown>
      | null
      | undefined;
    const gameId = data?.gameId;
    if (gameId != null) {
      // Game highlight or lowlight notification — open that game's film room.
      router.replace(`/game/${gameId}` as never);
    } else {
      // Season reel or unknown notification — fall back to the Games tab.
      router.replace('/(tabs)/games');
    }
  }, [lastResponse, router]);

  // Register for push notifications once signed in. Re-runs on sign-in so a
  // fresh token is always registered (tokens can rotate across app installs).
  useEffect(() => {
    if (!isSignedIn) return;
    let cancelled = false;

    async function registerPushToken() {
      try {
        await ensureHighlightChannel();

        // expo-notifications v57 declares NotificationPermissionsStatus as
        // extending PermissionResponse from 'expo', but expo SDK 54 doesn't
        // re-export that type, so TypeScript resolves it as `{}` and hides
        // `granted`/`status`. The runtime object is correct; cast safely.
        type _Perms = { granted: boolean };
        const existing = await Notifications.getPermissionsAsync() as unknown as _Perms;
        let isGranted = existing.granted;
        if (!isGranted) {
          const requested = await Notifications.requestPermissionsAsync() as unknown as _Perms;
          isGranted = requested.granted;
        }
        if (!isGranted) return;

        // Resolve the EAS project ID — required by getExpoPushTokenAsync for
        // standalone (non–Expo Go) builds. Checked explicitly so a missing ID
        // produces a named, actionable warning instead of a thrown error that
        // gets swallowed by the outer catch.
        //
        // To configure: run `eas init` in the hoops-mobile directory; the CLI
        // writes the UUID to app.json `expo.extra.eas.projectId` and to
        // eas.json. Alternatively set EXPO_PUBLIC_PROJECT_ID in eas.json build
        // env and the Replit Secrets panel.
        const projectId =
          (Constants.expoConfig?.extra as Record<string, any> | undefined)?.eas?.projectId as
            | string
            | undefined
          ?? process.env.EXPO_PUBLIC_PROJECT_ID;

        if (!projectId) {
          console.warn(
            '[PushNotifications] EAS project ID is not configured. ' +
            'Run `eas init` or set EXPO_PUBLIC_PROJECT_ID to enable push notifications.',
          );
          return;
        }

        const tokenResult = await Notifications.getExpoPushTokenAsync({ projectId });
        const pushToken = tokenResult.data;
        if (cancelled || !pushToken) return;

        const authToken = await getToken();
        if (!authToken) return;

        const baseUrl = process.env.EXPO_PUBLIC_DOMAIN
          ? `https://${process.env.EXPO_PUBLIC_DOMAIN}`
          : '';
        await fetch(`${baseUrl}/api/users/me/push-token`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify({ token: pushToken }),
        });
      } catch (err) {
        // Non-fatal — coach continues without push notifications.
        console.warn('[PushNotifications] Registration failed:', err);
      }
    }

    registerPushToken();
    return () => {
      cancelled = true;
    };
  }, [isSignedIn, getToken]);

  return null;
}
