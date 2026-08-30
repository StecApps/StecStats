/**
 * coldOpenIntegration.test.tsx — integration test for cold-open data load
 *
 * Uses a REAL QueryClient (not mocked) to prove that after Clerk settles on a
 * cold open, data renders in mounted components automatically — without any
 * pull-to-refresh gesture.
 *
 * Mechanism under test
 * --------------------
 * ApiAuthSetup calls `qc.resetQueries()` via useQueryClient() when isSignedIn
 * transitions to true. resetQueries() removes every cache entry (data and
 * errors) AND notifies active observers to re-fetch immediately. This means a
 * component whose query failed pre-auth (401) will automatically re-fetch and
 * render data once the token is available — no gesture needed.
 *
 * Why a separate file
 * -------------------
 * The unit test (coldOpenDataLoad.test.tsx) mocks @tanstack/react-query to
 * isolate ApiAuthSetup. This file imports the real library so a real QueryClient
 * and real useQuery observer can exercise the end-to-end data flow.
 *
 * Covers
 * ------
 * 1. A query that fails pre-auth (simulated 401) is in error state before sign-in.
 * 2. After isSignedIn→true, resetQueries() evicts the error and refetches.
 * 3. The mounted component renders the team name WITHOUT a pull-to-refresh.
 * 4. The query is fetched exactly twice: once pre-auth (fails), once post-auth (succeeds).
 */

// ── API client — capture setAuthTokenGetter; no-op setBaseUrl ─────────────────

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

// ── Imports — real @tanstack/react-query (NOT mocked) ────────────────────────

import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { ApiAuthSetup } from '../app/_layout';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Recursively search a react-test-renderer JSON tree for a text leaf. */
function treeContainsText(node: any, text: string): boolean {
  if (!node) return false;
  if (typeof node === 'string') return node === text;
  if (Array.isArray(node)) return node.some((n) => treeContainsText(n, text));
  if (node.children) return treeContainsText(node.children, text);
  return false;
}

/** Flush all pending promises and microtasks. */
async function flushAsync() {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetToken.mockResolvedValue('test-token');
  mockUseAuth.mockReturnValue({
    getToken: mockGetToken,
    isSignedIn: false,
    isLoaded: false,
    userId: null,
  });
});

// ── Integration test ──────────────────────────────────────────────────────────

describe('cold-open data load — real QueryClient integration', () => {
  test('data renders automatically after sign-in without a pull-to-refresh gesture', async () => {
    // ── Step 1: Set up fetch mock ──────────────────────────────────────────
    // First call simulates a pre-auth 401 (Clerk not ready yet).
    // Second call simulates a successful fetch once the token is available.
    let callCount = 0;
    const mockFetch = jest.fn().mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) {
        throw Object.assign(new Error('Unauthorized'), { status: 401 });
      }
      return [{ id: 1, name: 'Team Alpha' }];
    });

    // ── Step 2: Real QueryClient — no retries so failures settle quickly ───
    const realClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });

    // ── Step 3: DataConsumer — a minimal query observer ───────────────────
    // Uses the real useQuery hook so the observer is active while mounted.
    // Plain host-component strings (not react-native) keep the test portable.
    function DataConsumer() {
      const { data, isError, isPending } = useQuery<Array<{ id: number; name: string }>>({
        queryKey: ['teams'],
        queryFn: mockFetch,
        retry: false,
      });
      if (isPending) return React.createElement('loading', null, 'loading');
      if (isError) return React.createElement('error', null, 'error');
      return React.createElement('data', null, data![0].name);
    }

    // Wrap both ApiAuthSetup and DataConsumer in the same QueryClientProvider
    // so useQueryClient() inside ApiAuthSetup reads the same realClient.
    function Tree() {
      return React.createElement(
        QueryClientProvider,
        { client: realClient },
        React.createElement(ApiAuthSetup, null),
        React.createElement(DataConsumer, null),
      );
    }

    // ── Step 4: Mount — Clerk not yet loaded ──────────────────────────────
    let instance!: renderer.ReactTestRenderer;
    await act(async () => {
      instance = renderer.create(React.createElement(Tree));
    });

    // Let the initial (pre-auth) fetch settle asynchronously
    await flushAsync();

    // The query fired and failed (401) — error state, no data yet
    const preAuthState = realClient.getQueryState(['teams']);
    expect(preAuthState?.status).toBe('error');
    expect(treeContainsText(instance.toJSON(), 'error')).toBe(true);
    expect(treeContainsText(instance.toJSON(), 'Team Alpha')).toBe(false);

    // No pull-to-refresh has occurred at this point
    expect(callCount).toBe(1);

    // ── Step 5: Clerk settles — user is now signed in ─────────────────────
    mockUseAuth.mockReturnValue({
      getToken: mockGetToken,
      isSignedIn: true,
      isLoaded: true,
      userId: 'user_coach1',
    });

    await act(async () => {
      instance.update(React.createElement(Tree));
    });

    // resetQueries() fired inside ApiAuthSetup — active observer refetches
    await flushAsync();

    // ── Step 6: Assert data renders without any manual gesture ────────────
    const postAuthState = realClient.getQueryState(['teams']);
    expect(postAuthState?.status).toBe('success');
    expect(treeContainsText(instance.toJSON(), 'Team Alpha')).toBe(true);

    // Exactly two fetches: one pre-auth (failed), one post-auth (succeeded)
    expect(callCount).toBe(2);
  });

  test('query error state is fully cleared before the post-auth fetch', async () => {
    // Verifies that resetQueries() removes the error entry so the post-auth
    // fetch starts from a clean slate — not from a partial error state.
    let callCount = 0;
    const mockFetch = jest.fn().mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) throw new Error('401');
      return [{ id: 2, name: 'Warriors' }];
    });

    const realClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });

    function DataConsumer() {
      const { data, isError, isPending } = useQuery<Array<{ id: number; name: string }>>({
        queryKey: ['teams'],
        queryFn: mockFetch,
        retry: false,
      });
      if (isPending) return React.createElement('loading', null, 'loading');
      if (isError) return React.createElement('error', null, 'error');
      return React.createElement('data', null, data![0].name);
    }

    function Tree() {
      return React.createElement(
        QueryClientProvider,
        { client: realClient },
        React.createElement(ApiAuthSetup, null),
        React.createElement(DataConsumer, null),
      );
    }

    let instance!: renderer.ReactTestRenderer;
    await act(async () => { instance = renderer.create(React.createElement(Tree)); });
    await flushAsync();

    // Pre-auth: error cached
    expect(realClient.getQueryState(['teams'])?.status).toBe('error');

    // Clerk settles
    mockUseAuth.mockReturnValue({
      getToken: mockGetToken,
      isSignedIn: true,
      isLoaded: true,
      userId: 'user_coach1',
    });

    await act(async () => { instance.update(React.createElement(Tree)); });
    await flushAsync();

    // Post-auth: success — the error was fully replaced, not stacked
    expect(realClient.getQueryState(['teams'])?.status).toBe('success');
    expect(realClient.getQueryState(['teams'])?.error).toBeNull();
    expect(treeContainsText(instance.toJSON(), 'Warriors')).toBe(true);
  });
});
