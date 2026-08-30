/**
 * freshInstallSignIn.test.tsx
 *
 * Regression guard for the fresh-install sign-in loading state.
 *
 * Background
 * ----------
 * On a fresh install Clerk takes a moment to settle. Queries that fire before
 * the token is ready return 401, which React Query caches as an error entry.
 * When the user signs in, `ApiAuthSetup` calls `queryClient.resetQueries()` to
 * wipe those cached errors so components immediately re-enter a loading state
 * and re-fetch with the fresh Clerk token.
 *
 * `resetQueries()` is preferred over `clear()` because it notifies active
 * observers inline (mounted screens re-fetch immediately) whereas `clear()`
 * destroys observers and leaves mounted screens empty until their next render.
 * It is preferred over `invalidateQueries()` because invalidation does not
 * evict error entries — only data entries are subject to staleTime.
 *
 * Covers
 * ------
 * 1. QueryClient.resetQueries() removes a cached 401 error from the cache.
 * 2. QueryClient.invalidateQueries() does NOT remove a cached error entry —
 *    confirming why resetQueries() is needed.
 * 3. The production ApiAuthSetup (imported from _layout.tsx) calls
 *    queryClient.resetQueries() exactly once when isSignedIn transitions
 *    false → true.
 * 4. ApiAuthSetup does NOT call resetQueries() when isSignedIn stays true.
 * 5. ApiAuthSetup does NOT call resetQueries() when isSignedIn is false.
 * 6. After resetQueries() fires, the injected 401 error is gone from the cache.
 * 7. DashboardScreen renders ActivityIndicator (not "No players yet") when
 *    isLoading=true — a loading state must never show the empty-roster copy.
 * 8. DashboardScreen renders player data correctly when data is present.
 * 9. "No players yet" appears only when isLoading=false AND data is truly empty.
 * 10. Full integration sequence: ApiAuthSetup (real production code) resets the
 *     cached 401 error on sign-in; the QueryObserver transitions error → loading
 *     → data without ever showing an empty or error state.
 * 11. Negative control: without ApiAuthSetup/resetQueries(), the cached error
 *     blocks data from loading — confirming resetQueries() is the active
 *     mechanism.
 */

// ── Mocks for _layout.tsx module-level dependencies ───────────────────────────
// Declared before imports so Jest hoists them correctly. _layout.tsx executes
// module-level code (SplashScreen.preventAutoHideAsync, initializeRevenueCat,
// etc.) on import; all those dependencies must be stubbed.

jest.mock('expo-splash-screen', () => ({ preventAutoHideAsync: jest.fn() }));
jest.mock('expo-updates', () => ({
  isEnabled: false,
  checkForUpdateAsync: jest.fn(),
  fetchUpdateAsync: jest.fn(),
  reloadAsync: jest.fn(),
}));
jest.mock('expo-system-ui', () => ({ setBackgroundColorAsync: jest.fn() }));
jest.mock('expo-font', () => ({ useFonts: jest.fn(() => [true, null]) }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));
jest.mock('expo-notifications', () => ({
  AndroidImportance: { HIGH: 4 },
  setNotificationChannelAsync: jest.fn(),
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
  useLastNotificationResponse: jest.fn(() => null),
}));
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { extra: { eas: { projectId: 'test-project' } } } },
}));
jest.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: ({ children }: any) => children,
}));
jest.mock('react-native-keyboard-controller', () => ({
  KeyboardProvider: ({ children }: any) => children,
}));
jest.mock('@/components/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: any) => children,
}));
jest.mock('@expo-google-fonts/inter', () => ({
  Inter_400Regular: 'Inter_400Regular',
  Inter_500Medium: 'Inter_500Medium',
  Inter_600SemiBold: 'Inter_600SemiBold',
  Inter_700Bold: 'Inter_700Bold',
}));
jest.mock('@expo-google-fonts/teko', () => ({
  Teko_400Regular: 'Teko_400Regular',
  Teko_600SemiBold: 'Teko_600SemiBold',
  Teko_700Bold: 'Teko_700Bold',
}));

// ── Clerk mock — controllable per test via mockUseAuth ─────────────────────────

const mockUseAuth = jest.fn();
jest.mock('@clerk/expo', () => ({
  ClerkProvider: ({ children }: any) => children,
  useAuth: (...args: any[]) => mockUseAuth(...args),
  useUser: jest.fn(() => ({ user: { firstName: 'Test', fullName: 'Test Coach' } })),
}));

// ── Route / navigation stubs ──────────────────────────────────────────────────

jest.mock('expo-router', () => ({
  Stack: Object.assign(
    ({ children }: any) => children,
    { Screen: () => null },
  ),
  useRouter: jest.fn(() => ({ replace: jest.fn() })),
  useSegments: jest.fn(() => ['(tabs)']),
  useFocusEffect: jest.fn((cb: any) => cb()),
}));

// ── React Native / native UI mocks ────────────────────────────────────────────

jest.mock('react-native', () => {
  const React = require('react');
  const el = (tag: string) =>
    function MockEl({ children, ...rest }: any) {
      return React.createElement(tag, rest, children ?? null);
    };
  return {
    View: el('View'),
    Text: el('Text'),
    ScrollView: el('ScrollView'),
    TouchableOpacity: el('TouchableOpacity'),
    ActivityIndicator: el('ActivityIndicator'),
    RefreshControl: el('RefreshControl'),
    StyleSheet: {
      create: (s: any) => s,
      flatten: (s: any) =>
        Array.isArray(s) ? Object.assign({}, ...s.map((x: any) => x ?? {})) : s ?? {},
      absoluteFill: {},
      absoluteFillObject: {},
      hairlineWidth: 0.5,
    },
    Alert: { alert: jest.fn() },
    AppState: {
      currentState: 'active',
      addEventListener: jest.fn(() => ({ remove: jest.fn() })),
    },
    Platform: { OS: 'ios', select: (o: any) => o.ios ?? o.default },
    Share: { share: jest.fn() },
    useColorScheme: jest.fn(() => 'dark'),
    useWindowDimensions: jest.fn(() => ({ width: 390, height: 844 })),
  };
});

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: any) => children,
  useSafeAreaInsets: jest.fn(() => ({ top: 0, bottom: 0, left: 0, right: 0 })),
}));

jest.mock('expo-linear-gradient', () => {
  const React = require('react');
  return {
    LinearGradient: ({ children, ...rest }: any) =>
      React.createElement('LinearGradient', rest, children ?? null),
  };
});

jest.mock('expo-image', () => ({ Image: () => null }));
jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('react-native-svg', () => {
  const React = require('react');
  const el = (tag: string) =>
    ({ children, ...rest }: any) => React.createElement(tag, rest, children ?? null);
  return {
    __esModule: true,
    default: el('Svg'),
    Svg: el('Svg'),
    Circle: el('Circle'),
    G: el('G'),
    Path: el('Path'),
    Rect: el('Rect'),
  };
});

// ── Library stubs ─────────────────────────────────────────────────────────────

jest.mock('@/lib/revenuecat', () => ({
  initializeRevenueCat: jest.fn(),
  loginRevenueCat: jest.fn(),
  logoutRevenueCat: jest.fn(),
  SubscriptionProvider: ({ children }: any) => children,
}));

jest.mock('@/lib/useRevenueCatAuthSync', () => ({
  useRevenueCatAuthSync: jest.fn(),
}));

jest.mock('@/components/PendingPhotoRetry', () => ({
  PendingPhotoRetry: () => null,
}));

jest.mock('@/lib/pendingPhotoQueue', () => ({
  enqueuePhoto: jest.fn(),
  dequeuePhoto: jest.fn(),
}));

jest.mock('@/lib/photoUpload', () => ({
  uploadPhoto: jest.fn(),
  API_BASE: 'http://localhost',
}));

jest.mock('@/lib/tekoStyle', () => ({
  tekoStyle: (size: number) => ({ fontSize: size }),
}));

// ── api-client-react — fully mocked (source is uncompiled TS, requireActual
//    cannot load it in Jest's CJS runner). The listPlayers query key is the
//    real value (/api/players) so integration tests share the same key space.

const mockUseListPlayers = jest.fn();
const mockUseGetPlayerSummary = jest.fn();
const mockUseUpdatePlayer = jest.fn(() => ({ mutateAsync: jest.fn() }));

jest.mock('@workspace/api-client-react', () => ({
  useListPlayers: (...args: any[]) => mockUseListPlayers(...args),
  useGetPlayerSummary: (...args: any[]) => mockUseGetPlayerSummary(...args),
  useUpdatePlayer: (...args: any[]) => mockUseUpdatePlayer(...args),
  // Mirrors the real implementation: getListPlayersQueryKey() => ['/api/players']
  getListPlayersQueryKey: () => ['/api/players'],
  setAuthTokenGetter: jest.fn(),
  setBaseUrl: jest.fn(),
}));

// ── Imports (after all mocks) ─────────────────────────────────────────────────

import React, { useEffect } from 'react';
import renderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';

// Import the REAL production ApiAuthSetup. It is now exported from _layout.tsx
// and uses useQueryClient() so tests can inject a spy QueryClient via the
// provider — without this, removing the qc.resetQueries() call in production
// would leave any shim-based tests passing undetected.
import { ApiAuthSetup } from '../app/_layout';

// The listPlayers query key — matches the value returned by getListPlayersQueryKey().
const PLAYERS_QUERY_KEY = ['/api/players'] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Inject a 401-like error entry into a QueryClient's cache, simulating what
 * happens when a query fires before Clerk has settled and the API returns 401.
 * React Query v5 caches this as status='error', fetchStatus='idle'.
 */
function injectCachedError(qc: QueryClient): void {
  const query = qc.getQueryCache().build(qc, { queryKey: PLAYERS_QUERY_KEY as any });
  query.setState({
    status: 'error',
    error: new Error('401 Unauthorized'),
    data: undefined,
    dataUpdateCount: 0,
    dataUpdatedAt: 0,
    errorUpdateCount: 1,
    errorUpdatedAt: Date.now(),
    fetchFailureCount: 2, // retry:1 → 2 attempts before settling as error
    fetchFailureReason: null,
    fetchMeta: null,
    isInvalidated: false,
    fetchStatus: 'idle',
  });
}

/** Walk a react-test-renderer JSON tree, returning nodes matching the visitor. */
function findNodes(node: any, visitor: (n: any) => boolean, acc: any[] = []): any[] {
  if (!node) return acc;
  if (Array.isArray(node)) { node.forEach((c) => findNodes(c, visitor, acc)); return acc; }
  if (typeof node === 'object') {
    if (visitor(node)) acc.push(node);
    if (node.children) findNodes(node.children, visitor, acc);
  }
  return acc;
}

/** Return Text nodes whose joined children include substr. */
function findTexts(tree: any, substr: string): any[] {
  return findNodes(tree, (n) =>
    n.type === 'Text' && (n.children ?? []).join('').includes(substr),
  );
}

/** Create a fresh QueryClient and spy on its resetQueries() method. */
function makeSpyQc() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const resetSpy = jest.spyOn(qc, 'resetQueries');
  return { qc, resetSpy };
}

// ── Shared beforeEach ─────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();

  mockUseAuth.mockReturnValue({
    getToken: jest.fn(() => Promise.resolve('test-token')),
    isSignedIn: true,
    isLoaded: true,
    userId: 'user_test123',
  });

  mockUseGetPlayerSummary.mockReturnValue({
    data: {
      games: 10, wins: 6, losses: 4, points: 200, ppg: 20.0,
      rebounds: 80, rpg: 8.0, assists: 40, apg: 4.0,
      steals: 10, spg: 1.0, blocks: 5, bpg: 0.5,
      turnovers: 15, topg: 1.5, twoMade: 60, twoAttempted: 120,
      threeMade: 20, threeAttempted: 50, ftMade: 40, ftAttempted: 50,
      seasonScope: 'season',
    },
    isLoading: false,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Part 1: QueryClient cache semantics
// ─────────────────────────────────────────────────────────────────────────────

describe('QueryClient cache semantics — resetQueries() vs invalidateQueries()', () => {
  test('resetQueries() removes a cached 401 error — query status becomes pending', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    injectCachedError(qc);

    expect(qc.getQueryState(PLAYERS_QUERY_KEY)?.status).toBe('error');

    await qc.resetQueries({ queryKey: PLAYERS_QUERY_KEY });

    // After reset, the error is gone — status returns to pending (initial state)
    const after = qc.getQueryState(PLAYERS_QUERY_KEY);
    expect(after?.status).not.toBe('error');
  });

  test('invalidateQueries() does NOT remove a cached error — entry survives', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    injectCachedError(qc);

    await qc.invalidateQueries({ queryKey: PLAYERS_QUERY_KEY });

    // Error entry must still be present — invalidation only marks stale data.
    const after = qc.getQueryState(PLAYERS_QUERY_KEY);
    expect(after).toBeDefined();
    expect(after?.status).toBe('error');
  });

  test('a cached error has fetchStatus=idle — it will not re-fetch on its own', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    injectCachedError(qc);

    const state = qc.getQueryState(PLAYERS_QUERY_KEY);
    expect(state?.fetchStatus).toBe('idle');
    expect(state?.status).toBe('error');
  });

  test('after resetQueries(), the error is cleared — next consumer starts in loading state', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    injectCachedError(qc);

    await qc.resetQueries({ queryKey: PLAYERS_QUERY_KEY });

    // No stale error entry — a mounting component gets isLoading=true (spinner).
    expect(qc.getQueryState(PLAYERS_QUERY_KEY)?.status).not.toBe('error');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Part 2: Production ApiAuthSetup — resetQueries() fires on sign-in
// ─────────────────────────────────────────────────────────────────────────────
//
// Renders the real ApiAuthSetup from _layout.tsx (not a shim) inside a
// QueryClientProvider with a spy QueryClient. Removing or disabling the
// qc.resetQueries() call in production code would break every test in this
// block.

describe('ApiAuthSetup (production component) — resetQueries() fires on sign-in', () => {
  /** Render the real production ApiAuthSetup in a controlled QueryClientProvider. */
  function renderWithQc(
    authState: { isSignedIn: boolean; isLoaded: boolean; userId: string | null },
    qc: QueryClient,
  ) {
    mockUseAuth.mockReturnValue({
      getToken: jest.fn(() => Promise.resolve('test-token')),
      ...authState,
    });
    return renderer.create(
      <QueryClientProvider client={qc}>
        <ApiAuthSetup />
      </QueryClientProvider>,
    );
  }

  test('resetQueries() is called exactly once when isSignedIn transitions false → true', async () => {
    const { qc, resetSpy } = makeSpyQc();
    let instance!: renderer.ReactTestRenderer;

    // t=0: Clerk settling — isSignedIn=false
    await act(async () => {
      instance = renderWithQc({ isSignedIn: false, isLoaded: false, userId: null }, qc);
    });
    expect(resetSpy).not.toHaveBeenCalled();

    // t=1: Clerk settled — sign-in complete
    mockUseAuth.mockReturnValue({
      getToken: jest.fn(() => Promise.resolve('test-token')),
      isSignedIn: true, isLoaded: true, userId: 'user_abc',
    });
    await act(async () => {
      instance.update(
        <QueryClientProvider client={qc}>
          <ApiAuthSetup />
        </QueryClientProvider>,
      );
    });

    expect(resetSpy).toHaveBeenCalledTimes(1);
  });

  test('resetQueries() is NOT called a second time when isSignedIn stays true', async () => {
    const { qc, resetSpy } = makeSpyQc();
    let instance!: renderer.ReactTestRenderer;

    // t=0: already signed in — fires once on mount
    await act(async () => {
      instance = renderWithQc({ isSignedIn: true, isLoaded: true, userId: 'user_abc' }, qc);
    });
    expect(resetSpy).toHaveBeenCalledTimes(1);

    // t=1: another render — isSignedIn unchanged
    await act(async () => {
      instance.update(
        <QueryClientProvider client={qc}>
          <ApiAuthSetup />
        </QueryClientProvider>,
      );
    });

    // Must not fire again — isSignedIn didn't change
    expect(resetSpy).toHaveBeenCalledTimes(1);
  });

  test('resetQueries() is NOT called when isSignedIn is false throughout', async () => {
    const { qc, resetSpy } = makeSpyQc();

    await act(async () => {
      renderWithQc({ isSignedIn: false, isLoaded: false, userId: null }, qc);
    });

    expect(resetSpy).not.toHaveBeenCalled();
  });

  test('after resetQueries() fires, the injected 401 error is gone from the cache', async () => {
    const { qc, resetSpy } = makeSpyQc();
    injectCachedError(qc);

    expect(qc.getQueryState(PLAYERS_QUERY_KEY)?.status).toBe('error');

    let instance!: renderer.ReactTestRenderer;

    // t=0: not yet signed in — error stays cached, resetQueries() not called
    await act(async () => {
      instance = renderWithQc({ isSignedIn: false, isLoaded: false, userId: null }, qc);
    });
    expect(qc.getQueryState(PLAYERS_QUERY_KEY)?.status).toBe('error');
    expect(resetSpy).not.toHaveBeenCalled();

    // t=1: sign-in — ApiAuthSetup must reset the cache
    mockUseAuth.mockReturnValue({
      getToken: jest.fn(() => Promise.resolve('test-token')),
      isSignedIn: true, isLoaded: true, userId: 'user_abc',
    });
    await act(async () => {
      instance.update(
        <QueryClientProvider client={qc}>
          <ApiAuthSetup />
        </QueryClientProvider>,
      );
    });

    expect(resetSpy).toHaveBeenCalledTimes(1);
    // The 401 error must be gone
    expect(qc.getQueryState(PLAYERS_QUERY_KEY)?.status).not.toBe('error');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Part 3: DashboardScreen — loading state never shows error copy
// ─────────────────────────────────────────────────────────────────────────────

describe('DashboardScreen — loading state never shows error copy', () => {
  let DashboardScreen: React.ComponentType;
  // PlayerDashboard (rendered when data is present) calls useQueryClient()
  // directly, so a QueryClientProvider must be in context even for these
  // UI-only tests.
  let screenQc: QueryClient;

  beforeAll(() => {
    DashboardScreen = require('../app/(tabs)/index').default;
  });

  beforeEach(() => {
    screenQc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  function renderScreen() {
    return renderer.create(
      <QueryClientProvider client={screenQc}>
        <DashboardScreen />
      </QueryClientProvider>,
    );
  }

  test('renders ActivityIndicator when isLoading=true — not "No players yet"', async () => {
    mockUseListPlayers.mockReturnValue({ data: undefined, isLoading: true, refetch: jest.fn() });

    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderScreen(); });

    const json = tree.toJSON();
    expect(findNodes(json, (n) => n.type === 'ActivityIndicator').length).toBeGreaterThan(0);
    expect(findTexts(json, 'No players yet')).toHaveLength(0);
    expect(findTexts(json, 'failed')).toHaveLength(0);
  });

  test('renders player data when present — not loading, not empty', async () => {
    mockUseListPlayers.mockReturnValue({
      data: [{ id: 1, name: 'Alice Test', photoObjectPath: null }],
      isLoading: false,
      refetch: jest.fn(),
    });

    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderScreen(); });

    const json = tree.toJSON();
    expect(findTexts(json, 'No players yet')).toHaveLength(0);
    expect(findTexts(json, 'Alice Test').length).toBeGreaterThan(0);
  });

  test('"No players yet" appears only when isLoading=false AND data is empty', async () => {
    mockUseListPlayers.mockReturnValue({ data: [], isLoading: false, refetch: jest.fn() });

    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderScreen(); });

    const json = tree.toJSON();
    // Correct final state for an empty roster — must appear here, not during loading
    expect(findTexts(json, 'No players yet').length).toBeGreaterThan(0);
    // No spinner — loading is done
    expect(findNodes(json, (n) => n.type === 'ActivityIndicator')).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Part 4: Full integration sequence
// ─────────────────────────────────────────────────────────────────────────────
//
// Renders the real ApiAuthSetup alongside a QueryObserver that uses React
// Query's real useQuery hook with a controlled queryFn. This exercises the
// full production path without mocking at the hook level:
//
//   1. Cache starts with an injected 401 error (pre-auth window scenario).
//   2. isSignedIn transitions false → true.
//   3. The real production ApiAuthSetup calls qc.resetQueries().
//   4. QueryObserver re-enters loading (pending) state.
//   5. queryFn resolves with player data.
//   6. States recorded: error → loading → data. "empty" never appears.

describe('Full integration sequence — real ApiAuthSetup + real useQuery', () => {
  /**
   * A minimal component that uses React Query's real useQuery hook on the
   * listPlayers key with a controlled queryFn, recording every render state.
   * No mock intercepts the hook — it talks directly to the QueryClient from
   * context, so ApiAuthSetup.resetQueries() genuinely resets its state.
   *
   * retryOnMount:false is required here because React Query's default behaviour
   * is to attempt a background refetch whenever a component mounts with an
   * error-state query (retryOnMount defaults to true). That automatic retry
   * would bypass the injected 401 error before ApiAuthSetup.resetQueries()
   * fires, making it impossible to observe the intended error → reset →
   * loading → data sequence. Setting retryOnMount:false ensures the cached
   * error sits idle until resetQueries() evicts it, exactly as in the
   * production scenario where retry:1 (two total attempts) exhausts retries
   * before Clerk settles.
   */
  function QueryObserver({
    queryFn,
    states,
  }: {
    queryFn: () => Promise<any>;
    states: string[];
  }) {
    const result = useQuery({
      queryKey: PLAYERS_QUERY_KEY,
      queryFn,
      retry: false,
      retryOnMount: false,
    });

    useEffect(() => {
      const s =
        result.isLoading  // isPending && fetchStatus==='fetching' — active first fetch
          ? 'loading'
          : result.isError
          ? 'error'
          : (result.data as any[])?.length
          ? 'data'
          : 'empty';
      states.push(s);
    });

    return null;
  }

  test('error → reset → loading → data: "empty" never appears in the sequence', async () => {
    // retryOnMount:false mirrors the QueryObserver setting above — the QC-level
    // option ensures ApiAuthSetup (which uses the same client) also doesn't
    // inadvertently trigger a retry when it first mounts.
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, retryOnMount: false } },
    });

    // Pre-populate the cache with a 401 error (simulates pre-auth window)
    injectCachedError(qc);

    // queryFn resolves successfully — simulates API responding after auth
    const queryFn = jest.fn().mockResolvedValue([{ id: 1, name: 'Alice' }]);
    const states: string[] = [];

    // t=0: mount with isSignedIn=false — error is cached, no resetQueries() yet
    mockUseAuth.mockReturnValue({
      getToken: jest.fn(() => Promise.resolve('test-token')),
      isSignedIn: false, isLoaded: false, userId: null,
    });

    let instance!: renderer.ReactTestRenderer;
    await act(async () => {
      instance = renderer.create(
        <QueryClientProvider client={qc}>
          <ApiAuthSetup />
          <QueryObserver queryFn={queryFn} states={states} />
        </QueryClientProvider>,
      );
    });

    // Observer rendered at least once — sees the cached error
    expect(states).toContain('error');

    // t=1: Clerk settles — ApiAuthSetup resets the cache, queryFn re-fires
    mockUseAuth.mockReturnValue({
      getToken: jest.fn(() => Promise.resolve('test-token')),
      isSignedIn: true, isLoaded: true, userId: 'user_abc',
    });

    await act(async () => {
      instance.update(
        <QueryClientProvider client={qc}>
          <ApiAuthSetup />
          <QueryObserver queryFn={queryFn} states={states} />
        </QueryClientProvider>,
      );
      // Flush pending promise resolutions so queryFn result settles
      await Promise.resolve();
      await Promise.resolve();
    });

    // queryFn must have been called — cache was reset and the query re-fetched
    expect(queryFn).toHaveBeenCalled();

    // "empty" must never have appeared — that would be the "No players yet" flash
    expect(states).not.toContain('empty');

    // The sequence ends in data
    const lastNonLoading = [...states].reverse().find((s) => s !== 'loading');
    expect(lastNonLoading).toBe('data');
  });

  test('negative control: without ApiAuthSetup, the 401 error blocks re-fetch', async () => {
    // Confirms that resetQueries() is the active mechanism. Without ApiAuthSetup
    // the cached error is never evicted and the queryFn is never called.
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, retryOnMount: false } },
    });
    injectCachedError(qc);

    const queryFn = jest.fn().mockResolvedValue([{ id: 1, name: 'Alice' }]);
    const states: string[] = [];

    await act(async () => {
      renderer.create(
        <QueryClientProvider client={qc}>
          {/* ApiAuthSetup intentionally absent — no resetQueries() will fire */}
          <QueryObserver queryFn={queryFn} states={states} />
        </QueryClientProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    // Without resetQueries(), the cached error persists; queryFn is never called.
    expect(queryFn).not.toHaveBeenCalled();
    expect(states).not.toContain('data');
    expect(states).toContain('error');
  });
});
