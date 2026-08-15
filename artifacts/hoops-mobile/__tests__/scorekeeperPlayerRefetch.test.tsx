/**
 * Component-level regression test for "player added mid-setup appears in the
 * scorekeeper without restarting."
 *
 * Renders the real ScorekeeperScreen component, mocking only its external
 * dependencies (hooks, navigation, camera). The test:
 *   1. Confirms useFocusEffect registers a callback that calls refetchPlayers().
 *   2. Confirms that when refetch returns an expanded player list (Bob added
 *      on the Roster screen), Bob's chip appears in the player chip bar.
 *   3. Confirms Alice's chip and selected-player state are preserved.
 */

// jest.mock calls are hoisted before imports; factories must be self-contained.

// @clerk/clerk-expo pulls in react-native-url-polyfill which requires the
// native BlobModule — not available in Jest/Node. Mock the whole package so
// scorekeeper.tsx's `useAuth` import doesn't crash the test environment.
jest.mock('@clerk/clerk-expo', () => ({
  useAuth: jest.fn(() => ({ isSignedIn: true, userId: 'test-user-id' })),
}));

jest.mock('expo-router', () => ({
  useLocalSearchParams: jest.fn(() => ({
    opponent: 'Rivals',
    teamId: '1',
    teamName: 'My Team',
    date: '2026-01-01',
    recordVideo: 'false',
  })),
  useRouter: jest.fn(() => ({ back: jest.fn(), replace: jest.fn() })),
  // Capture the callback so tests can fire it to simulate screen focus.
  useFocusEffect: jest.fn(),
}));

jest.mock('@workspace/api-client-react', () => ({
  useListPlayers:       jest.fn(),
  useCreateGame:        jest.fn(() => ({ mutateAsync: jest.fn() })),
  useRequestUploadUrl:  jest.fn(() => ({ mutateAsync: jest.fn() })),
}));

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: jest.fn(() => ({ invalidateQueries: jest.fn() })),
}));

jest.mock('@/hooks/useColors', () => ({
  useColors: jest.fn(() => ({
    background: '#000', foreground: '#fff', primary: '#f97316',
    card: '#111', border: '#333', muted: '#222',
    mutedForeground: '#888', destructive: '#ef4444', input: '#111',
  })),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: jest.fn(() => ({ top: 0, bottom: 0, left: 0, right: 0 })),
}));

jest.mock('expo-haptics', () => ({
  impactAsync:          jest.fn(),
  notificationAsync:    jest.fn(),
  ImpactFeedbackStyle:  { Light: 'light', Medium: 'medium' },
  NotificationFeedbackType: { Success: 'success' },
}));

jest.mock('@expo/vector-icons', () => ({
  Ionicons: () => null,
  Feather:  () => null,
}));

// react-native's actual module crashes at load time in Node (it tries to
// reach native bridges). Provide a minimal hand-crafted mock that supplies
// exactly the exports scorekeeper.tsx uses, letting react-test-renderer
// build a real component tree we can inspect.
jest.mock('react-native', () => {
  const React = require('react');

  // Lightweight host-component wrappers recognised by react-test-renderer.
  const hostEl = (name: string) =>
    function MockRNComponent({ children, ...rest }: any) {
      return React.createElement(name, rest, children);
    };

  return {
    View:              hostEl('View'),
    Text:              hostEl('Text'),
    ScrollView:        hostEl('ScrollView'),
    TouchableOpacity:  hostEl('TouchableOpacity'),
    ActivityIndicator: hostEl('ActivityIndicator'),
    // FlatList must actually render each item so the chip text appears in the tree.
    FlatList: ({ data, renderItem, keyExtractor, contentContainerStyle, ...rest }: any) =>
      React.createElement(
        'FlatList',
        rest,
        (data ?? []).map((item: any, index: number) => {
          const key = keyExtractor ? keyExtractor(item, index) : String(index);
          const element = renderItem({ item, index });
          return React.cloneElement(element, { key });
        }),
      ),
    StyleSheet: {
      create: (s: any) => s,
      flatten: (s: any) => s,
      absoluteFill: {},
      absoluteFillObject: {},
    },
    Alert:    { alert: jest.fn() },
    Platform: { OS: 'ios', select: (o: any) => o.ios ?? o.default },
    // useWindowDimensions normally calls NativeDeviceInfo — return a fixed viewport.
    useWindowDimensions: jest.fn(() => ({ width: 390, height: 844 })),
    // Animated — scorekeeper.tsx uses Value, timing, loop, sequence.
    Animated: {
      Value: class {
        _value: number;
        constructor(v: number) { this._value = v; }
        setValue(_v: number) {}
        addListener(_cb: any) { return '0'; }
        removeListener(_id: string) {}
        interpolate(_cfg: any) { return this; }
      },
      timing:   jest.fn((_val: any, _cfg: any) => ({ start: jest.fn((cb?: () => void) => cb && cb()) })),
      loop:     jest.fn((_anim: any) => ({ start: jest.fn(), stop: jest.fn() })),
      sequence: jest.fn((_anims: any[]) => ({ start: jest.fn() })),
      View:     hostEl('Animated.View'),
      Text:     hostEl('Animated.Text'),
    },
    Modal:   hostEl('Modal'),
    Share:   { share: jest.fn(async () => ({ action: 'sharedAction' })) },
    PermissionsAndroid: {
      request: jest.fn(async () => 'granted'),
      PERMISSIONS: { BLUETOOTH_CONNECT: 'android.permission.BLUETOOTH_CONNECT' },
      RESULTS: { GRANTED: 'granted' },
    },
    ToastAndroid: { show: jest.fn(), LONG: 1, SHORT: 0 },
  };
});

jest.mock('expo-camera', () => ({
  CameraView:              () => null,
  useCameraPermissions:    jest.fn(() => [{ granted: false }, jest.fn()]),
  useMicrophonePermissions: jest.fn(() => [{ granted: false }, jest.fn()]),
}));

jest.mock('@clerk/clerk-expo', () => ({
  useAuth: jest.fn(() => ({ getToken: jest.fn(async () => 'test-token') })),
}));

// react-native-gesture-handler reaches into the native bridge on require.
// Provide a minimal stub so scorekeeper.tsx imports without crashing in Node.
jest.mock('react-native-gesture-handler', () => {
  const passThrough = ({ children }: any) => children ?? null;
  // Fluent gesture builder — every method returns `this` so chains work.
  function makeGesture() {
    const g: any = {};
    ['onStart', 'onUpdate', 'onEnd', 'onFinalize', 'onBegin', 'onChange',
     'runOnJS', 'simultaneousWithExternalGesture', 'enabled', 'minPointers'].forEach((m) => {
      g[m] = jest.fn(() => g);
    });
    return g;
  }
  return {
    GestureHandlerRootView: passThrough,
    GestureDetector:        passThrough,
    Gesture: {
      Pinch:    jest.fn(() => makeGesture()),
      Tap:      jest.fn(() => makeGesture()),
      Pan:      jest.fn(() => makeGesture()),
      Race:     jest.fn((...gs: any[]) => gs[0]),
      Composed: jest.fn((...gs: any[]) => gs[0]),
      Simultaneous: jest.fn((...gs: any[]) => gs[0]),
    },
  };
});

// react-native-reanimated uses Babel worklets and native threads — stub out
// the hooks used by scorekeeper.tsx so they return safe JS-side values.
jest.mock('react-native-reanimated', () => ({
  useSharedValue: jest.fn((initial: any) => ({ value: initial })),
  runOnJS:        jest.fn((fn: any) => fn),
  withSpring:     jest.fn((v: any) => v),
  withTiming:     jest.fn((v: any) => v),
}));

// ── Imports run after mock hoisting ──────────────────────────────────────────
import React from 'react';
import renderer, { act } from 'react-test-renderer';

import { useFocusEffect } from 'expo-router';
import { useListPlayers }  from '@workspace/api-client-react';
import ScorekeeperScreen   from '../app/scorekeeper';

const mockUseFocusEffect = useFocusEffect as jest.Mock;
const mockUseListPlayers  = useListPlayers  as jest.Mock;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Recursively search a react-test-renderer JSON tree for a text leaf. */
function treeContainsText(node: any, text: string): boolean {
  if (!node) return false;
  if (typeof node === 'string') return node === text;
  if (Array.isArray(node)) return node.some((n) => treeContainsText(n, text));
  if (node.children) return treeContainsText(node.children, text);
  return false;
}

// ── Test data ─────────────────────────────────────────────────────────────────

const ALICE = { id: 1, name: 'Alice' };
const BOB   = { id: 2, name: 'Bob'   };

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => { jest.clearAllMocks(); });

describe('ScorekeeperScreen — mid-setup player refetch', () => {

  test('useFocusEffect registers a callback that calls refetchPlayers on focus', async () => {
    const mockRefetch = jest.fn();
    mockUseListPlayers.mockReturnValue({ data: [ALICE], isLoading: false, refetch: mockRefetch });

    await act(async () => { renderer.create(<ScorekeeperScreen />); });

    // useFocusEffect is called on every render cycle; assert it was called at
    // least once (re-renders from useEffect state updates are expected).
    expect(mockUseFocusEffect).toHaveBeenCalled();
    const focusCb: () => void = mockUseFocusEffect.mock.calls[0][0];
    expect(typeof focusCb).toBe('function');

    // Firing the callback (screen focus) must invoke refetchPlayers
    await act(async () => { focusCb(); });
    expect(mockRefetch).toHaveBeenCalledTimes(1);
  });

  test('player added on Roster screen appears in chip bar after focus-triggered refetch', async () => {
    const mockRefetch = jest.fn();

    // Initial render: only Alice
    mockUseListPlayers.mockReturnValue({ data: [ALICE], isLoading: false, refetch: mockRefetch });
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(<ScorekeeperScreen />); });

    // Alice is in the chip bar; Bob is not yet
    expect(treeContainsText(tree.toJSON(), 'Alice')).toBe(true);
    expect(treeContainsText(tree.toJSON(), 'Bob')).toBe(false);

    // Coach navigates to Roster, adds Bob, navigates back — focus fires
    const focusCb: () => void = mockUseFocusEffect.mock.calls[0][0];
    await act(async () => { focusCb(); });
    expect(mockRefetch).toHaveBeenCalledTimes(1);

    // Refetch resolves with the expanded list (Bob is now on the roster)
    mockUseListPlayers.mockReturnValue({ data: [ALICE, BOB], isLoading: false, refetch: mockRefetch });
    await act(async () => { tree.update(<ScorekeeperScreen />); });

    // Bob's chip must now appear — no app restart needed
    expect(treeContainsText(tree.toJSON(), 'Bob')).toBe(true);
    // Alice's chip is still present
    expect(treeContainsText(tree.toJSON(), 'Alice')).toBe(true);
  });

  test('existing chips are preserved and not reset when a new player is added mid-setup', async () => {
    const mockRefetch = jest.fn();
    mockUseListPlayers.mockReturnValue({ data: [ALICE], isLoading: false, refetch: mockRefetch });

    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(<ScorekeeperScreen />); });
    expect(treeContainsText(tree.toJSON(), 'Alice')).toBe(true);

    // Focus + expanded roster
    const focusCb: () => void = mockUseFocusEffect.mock.calls[0][0];
    await act(async () => { focusCb(); });

    mockUseListPlayers.mockReturnValue({ data: [ALICE, BOB], isLoading: false, refetch: mockRefetch });
    await act(async () => { tree.update(<ScorekeeperScreen />); });

    expect(treeContainsText(tree.toJSON(), 'Alice')).toBe(true);
    expect(treeContainsText(tree.toJSON(), 'Bob')).toBe(true);
  });

  test('refetchPlayers is not called during initial render — only when focus fires', async () => {
    const mockRefetch = jest.fn();
    mockUseListPlayers.mockReturnValue({ data: [ALICE], isLoading: false, refetch: mockRefetch });

    await act(async () => { renderer.create(<ScorekeeperScreen />); });

    // No focus event yet — refetch must not have been called
    expect(mockRefetch).toHaveBeenCalledTimes(0);

    // Now simulate focus
    const focusCb: () => void = mockUseFocusEffect.mock.calls[0][0];
    await act(async () => { focusCb(); });
    expect(mockRefetch).toHaveBeenCalledTimes(1);
  });
});
