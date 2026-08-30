/**
 * coldOpenDataLoad.test.tsx  — unit tests for ApiAuthSetup
 *
 * Background
 * ----------
 * On a cold open the QueryClient can accumulate 401 error entries before Clerk
 * has finished loading. Unlike stale data, React Query error entries are NOT
 * subject to staleTime, so invalidateQueries() leaves them in place. The fix
 * calls `queryClient.resetQueries()` via useQueryClient(), which removes every
 * cache entry (data AND errors) AND notifies active observers to refetch
 * immediately — no pull-to-refresh required.
 *
 * Two fix points in ApiAuthSetup:
 *   1. `setAuthTokenGetter` is registered as soon as `getToken` is available,
 *      without a stale-closure guard on `isSignedIn`.
 *   2. When `isSignedIn` transitions to true, `qc.resetQueries()` is called via
 *      useQueryClient() so every cached 401 error is evicted and active observers
 *      re-fetch automatically.
 *
 * Note on mock hoisting
 * ---------------------
 * jest.mock() factories are hoisted before `const`/`let` declarations, so any
 * mock state (e.g. the QueryClient instance) must live INSIDE the factory.
 * Retrieve it afterwards via jest.requireMock() — never close over module-scope
 * `const` variables from inside a jest.mock() factory.
 *
 * Covers
 * ------
 * 1. Cold open: isLoaded=false → isLoaded=true, isSignedIn=true.
 *    qc.resetQueries() must be called automatically (no gesture needed).
 * 2. setAuthTokenGetter is registered with a function wrapping getToken().
 * 3. qc.resetQueries() is NOT called during the transient loading window
 *    (isLoaded=false, isSignedIn=false) — avoids a spurious cache bust.
 * 4. qc.resetQueries() is NOT called again on re-renders when isSignedIn
 *    stays true — the effect is edge-triggered on the sign-in transition.
 *
 * For proof that data actually renders without a gesture, see the companion
 * integration test: coldOpenIntegration.test.tsx (uses real QueryClient).
 */

// ── @tanstack/react-query — keep mock state inside factory ───────────────────
//
// jest.mock factories are hoisted above const declarations. Building the mock
// instance INSIDE the factory and exposing it as _mockInstance avoids the
// temporal-dead-zone problem that would make variables undefined at factory time.
//
// ApiAuthSetup calls qc.resetQueries() (via useQueryClient) — not clear() or
// invalidateQueries() — because resetQueries notifies active observers so they
// refetch inline rather than leaving mounted screens empty.

jest.mock('@tanstack/react-query', () => {
  const resetQueries = jest.fn().mockResolvedValue(undefined);
  const instance = { resetQueries };
  return {
    QueryClient: jest.fn(() => instance),
    QueryClientProvider: ({ children }: any) => children,
    useQueryClient: jest.fn(() => instance),
    // Exposed so tests can assert on it via jest.requireMock()
    _mockInstance: instance,
  };
});

// ── API client — capture setAuthTokenGetter calls ─────────────────────────────

const mockSetAuthTokenGetter = jest.fn();

jest.mock('@workspace/api-client-react', () => ({
  setBaseUrl: jest.fn(),
  setAuthTokenGetter: (...args: any[]) => mockSetAuthTokenGetter(...args),
}));

// ── Clerk — control auth state per test ───────────────────────────────────────

const mockGetToken = jest.fn().mockResolvedValue('test-token');
const mockUseAuth = jest.fn(() => ({
  getToken: mockGetToken,
  isSignedIn: false,
  isLoaded: false,
  userId: null,
}));

jest.mock('@clerk/expo', () => ({
  ClerkProvider: ({ children }: any) => children,
  useAuth: (...args: any[]) => mockUseAuth(...args),
}));

// ── RevenueCat — no-op ────────────────────────────────────────────────────────

jest.mock('@/lib/revenuecat', () => ({
  initializeRevenueCat: jest.fn(),
  SubscriptionProvider: ({ children }: any) => children,
}));

jest.mock('@/lib/useRevenueCatAuthSync', () => ({
  useRevenueCatAuthSync: jest.fn(),
}));

// ── Expo modules — no-op side effects ────────────────────────────────────────

jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(),
  hideAsync: jest.fn(),
}));

jest.mock('expo-system-ui', () => ({
  setBackgroundColorAsync: jest.fn(),
}));

jest.mock('expo-font', () => ({
  useFonts: jest.fn(() => [true, null]),
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

jest.mock('expo-router', () => ({
  Stack: Object.assign(() => null, { Screen: () => null }),
  useRouter: jest.fn(() => ({ replace: jest.fn() })),
  useSegments: jest.fn(() => []),
}));

// ── Native UI providers — pass-through wrappers ───────────────────────────────

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: any) => children,
  useSafeAreaInsets: jest.fn(() => ({ top: 0, bottom: 0, left: 0, right: 0 })),
}));

jest.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: ({ children }: any) => children,
}));

jest.mock('react-native-keyboard-controller', () => ({
  KeyboardProvider: ({ children }: any) => children,
}));

// ── Internal components — not under test ─────────────────────────────────────

jest.mock('@/components/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: any) => children,
}));

jest.mock('@/components/PendingPhotoRetry', () => ({
  PendingPhotoRetry: () => null,
}));

// ── Font packages — empty objects ─────────────────────────────────────────────

jest.mock('@expo-google-fonts/inter', () => ({
  Inter_400Regular: null,
  Inter_500Medium: null,
  Inter_600SemiBold: null,
  Inter_700Bold: null,
}));

jest.mock('@expo-google-fonts/teko', () => ({
  Teko_400Regular: null,
  Teko_600SemiBold: null,
  Teko_700Bold: null,
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { ApiAuthSetup } from '../app/_layout';

// ── Shared mock handle — retrieved after module registration ──────────────────
//
// jest.requireMock() is safe here: all jest.mock() factories have already run.

const { _mockInstance } = jest.requireMock('@tanstack/react-query') as {
  _mockInstance: { resetQueries: jest.Mock };
};

// ── Helpers ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockGetToken.mockResolvedValue('test-token');
  // Default: Clerk not yet loaded (cold-open transient window)
  mockUseAuth.mockReturnValue({
    getToken: mockGetToken,
    isSignedIn: false,
    isLoaded: false,
    userId: null,
  });
});

// ── Test 1: token getter is registered immediately ────────────────────────────

describe('ApiAuthSetup — token getter registration', () => {
  test('setAuthTokenGetter is called on mount with a function that calls getToken()', async () => {
    await act(async () => {
      renderer.create(<ApiAuthSetup />);
    });

    expect(mockSetAuthTokenGetter).toHaveBeenCalledTimes(1);
    const getter = mockSetAuthTokenGetter.mock.calls[0][0];
    expect(typeof getter).toBe('function');

    // Calling the registered getter must delegate to Clerk's getToken
    await getter();
    expect(mockGetToken).toHaveBeenCalledTimes(1);
  });
});

// ── Test 2: cold open — no spurious cache reset during loading ────────────────

describe('ApiAuthSetup — cold open transient window (isLoaded=false)', () => {
  test('resetQueries is NOT called while Clerk is still loading', async () => {
    await act(async () => {
      renderer.create(<ApiAuthSetup />);
    });

    expect(_mockInstance.resetQueries).not.toHaveBeenCalled();
  });
});

// ── Test 3: cold open — data loads automatically once Clerk settles ───────────

describe('ApiAuthSetup — cold open data load (no pull-to-refresh)', () => {
  test('resetQueries IS called automatically when Clerk settles with a signed-in session', async () => {
    // t=0  App launches — Clerk not yet loaded (cold open)
    let instance!: renderer.ReactTestRenderer;
    await act(async () => {
      instance = renderer.create(<ApiAuthSetup />);
    });

    expect(_mockInstance.resetQueries).not.toHaveBeenCalled();

    // t=1  Clerk has restored the session from SecureStore — signed in
    mockUseAuth.mockReturnValue({
      getToken: mockGetToken,
      isSignedIn: true,
      isLoaded: true,
      userId: 'user_coach1',
    });

    await act(async () => {
      instance.update(<ApiAuthSetup />);
    });

    // resetQueries notifies active observers and triggers an immediate refetch
    // — no pull-to-refresh gesture needed.
    expect(_mockInstance.resetQueries).toHaveBeenCalledTimes(1);
  });

  test('data becomes available on the first render after sign-in — not only after a manual gesture', async () => {
    // Simulate: queries were cached as 401 errors before Clerk was ready.
    // Once Clerk settles, resetQueries evicts every cached error and notifies
    // mounted observers to refetch with the real Clerk token.
    let instance!: renderer.ReactTestRenderer;
    await act(async () => {
      instance = renderer.create(<ApiAuthSetup />);
    });

    // No gesture has occurred — cache reset must not have fired yet
    expect(_mockInstance.resetQueries).not.toHaveBeenCalled();

    // Clerk finishes loading — auth token is now available
    mockUseAuth.mockReturnValue({
      getToken: mockGetToken,
      isSignedIn: true,
      isLoaded: true,
      userId: 'user_coach1',
    });

    await act(async () => {
      instance.update(<ApiAuthSetup />);
    });

    // The automatic cache reset fires — data loads without any gesture
    expect(_mockInstance.resetQueries).toHaveBeenCalledTimes(1);

    // The registered token getter is still wired to the live getToken reference
    const getter = mockSetAuthTokenGetter.mock.calls[0][0];
    const token = await getter();
    expect(mockGetToken).toHaveBeenCalled();
    expect(token).toBe('test-token');
  });
});

// ── Test 4: resetQueries is edge-triggered — not called on re-renders ─────────

describe('ApiAuthSetup — no duplicate cache resets on re-render', () => {
  test('resetQueries is called exactly once even if the component re-renders while still signed in', async () => {
    // Start signed in from the first render (e.g. session token was cached)
    mockUseAuth.mockReturnValue({
      getToken: mockGetToken,
      isSignedIn: true,
      isLoaded: true,
      userId: 'user_coach1',
    });

    let instance!: renderer.ReactTestRenderer;
    await act(async () => {
      instance = renderer.create(<ApiAuthSetup />);
    });

    expect(_mockInstance.resetQueries).toHaveBeenCalledTimes(1);

    // Simulate a re-render with the same signed-in state (e.g. parent state change)
    await act(async () => {
      instance.update(<ApiAuthSetup />);
    });

    // Must still be exactly one call — no duplicate cache resets
    expect(_mockInstance.resetQueries).toHaveBeenCalledTimes(1);
  });
});

// ── Test 5: full cold-open sequence ──────────────────────────────────────────

describe('ApiAuthSetup — full cold-open sequence', () => {
  test('token getter is wired and cache is reset after the full loading sequence', async () => {
    // t=0  App launches — Clerk loading
    let instance!: renderer.ReactTestRenderer;
    await act(async () => {
      instance = renderer.create(<ApiAuthSetup />);
    });

    // Token getter must already be registered (even before sign-in is confirmed)
    expect(mockSetAuthTokenGetter).toHaveBeenCalledTimes(1);
    expect(_mockInstance.resetQueries).not.toHaveBeenCalled();

    // t=1  Clerk restores session
    mockUseAuth.mockReturnValue({
      getToken: mockGetToken,
      isSignedIn: true,
      isLoaded: true,
      userId: 'user_coach1',
    });

    await act(async () => {
      instance.update(<ApiAuthSetup />);
    });

    // Both postconditions of the fix must hold simultaneously:
    // - Token getter registered (subsequent queries can authenticate)
    // - Cache reset (stale 401 errors evicted; active observers refetch immediately)
    expect(mockSetAuthTokenGetter).toHaveBeenCalled();
    expect(_mockInstance.resetQueries).toHaveBeenCalledTimes(1);
  });
});
