/**
 * Regression guard: Go Live button visibility + LIVE badge in collapsed preview.
 *
 * Test 1 — Go Live button is hidden when camera/mic permission is denied.
 *   The button lives inside {cameraReady && <camControls>} which only renders
 *   when both camera AND mic permissions are granted.  Guard: verify no
 *   TouchableOpacity with disabled={false} (the Go Live button's unique prop
 *   among sibling buttons) exists in the tree when either permission is absent.
 *
 * Test 2 — LIVE badge is visible in the collapsed previewHiddenOverlay.
 *   After a successful startLiveBroadcast (mocked fetch) sets isLive=true,
 *   collapsing the preview must still show the pulsing LIVE badge so the coach
 *   knows the broadcast is active.  Guard: after pressing Go Live then eye-off,
 *   verify the "LIVE" text node appears inside the collapsed overlay.
 */

// ── Global test-environment stubs ─────────────────────────────────────────────
// RTCPeerConnection is undefined in Node; set to null so scorekeeper's
// webrtcSupported guard short-circuits without crashing.
(global as any).RTCPeerConnection = null;

// WebSocket mock — connectBroadcasterWs constructs one after startLiveBroadcast.
const mockWsInstance = {
  send: jest.fn(),
  close: jest.fn(),
  readyState: 0,
  onopen: null as any,
  onclose: null as any,
  onmessage: null as any,
  onerror: null as any,
};
(global as any).WebSocket = jest.fn(() => mockWsInstance);

// fetch mock — returns a successful go-live response.
(global as any).fetch = jest.fn(async (url: string) => {
  if (String(url).includes('/api/live/start')) {
    return {
      ok: true,
      json: async () => ({ code: 'TESTLIVE' }),
    };
  }
  return { ok: true, json: async () => ({}) };
});

// ── jest.mock calls — hoisted before imports ──────────────────────────────────

jest.mock('@clerk/expo', () => ({
  useAuth: jest.fn(() => ({
    isSignedIn: true,
    userId: 'test-user',
    getToken: jest.fn(async () => 'test-token'),
  })),
}));

jest.mock('expo-router', () => ({
  useLocalSearchParams: jest.fn(() => ({
    opponent: 'Rivals',
    teamId: '1',
    teamName: 'My Team',
    date: '2026-01-01',
    recordVideo: 'true',   // camera recording enabled for both tests
  })),
  useRouter: jest.fn(() => ({ back: jest.fn(), replace: jest.fn() })),
  useFocusEffect: jest.fn(),
}));

jest.mock('@workspace/api-client-react', () => {
  // IMPORTANT: the players array must be a stable reference across calls.
  // useEffect([players]) in scorekeeper fires whenever the reference changes,
  // so a new array per call triggers an infinite setState → re-render loop.
  const STABLE_PLAYERS = [{ id: 1, name: 'Alice' }];
  const STABLE_LIST_RESULT = { data: STABLE_PLAYERS, isLoading: false, refetch: jest.fn() };
  return {
    useListPlayers:      jest.fn(() => STABLE_LIST_RESULT),
    useCreateGame:       jest.fn(() => ({ mutateAsync: jest.fn() })),
    useRequestUploadUrl: jest.fn(() => ({ mutateAsync: jest.fn() })),
  };
});

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
  impactAsync:         jest.fn(),
  notificationAsync:   jest.fn(),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
  NotificationFeedbackType: { Success: 'success' },
}));

jest.mock('@expo/vector-icons', () => ({
  Ionicons: () => null,
  Feather:  () => null,
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem:    jest.fn(async () => null),
  setItem:    jest.fn(async () => {}),
  removeItem: jest.fn(async () => {}),
}));

jest.mock('@/lib/noVideoAlert',     () => ({ showNoVideoAlert: jest.fn() }));
jest.mock('@/lib/uploadVideoFile',  () => ({ uploadVideoFile: jest.fn(), UPLOAD_CANCELLED_MSG: 'cancelled' }));
jest.mock('@/lib/tekoStyle',        () => ({ tekoStyle: (size: number) => ({ fontSize: size }) }));
jest.mock('@/lib/saveGame',         () => ({ saveGame: jest.fn(), defaultLine: () => ({}) }));
jest.mock('@/lib/uploadStallAlert', () => ({ makeUploadStallHandler: jest.fn(() => jest.fn()) }));
jest.mock('@/lib/fetchIceServers',  () => ({ fetchIceServers: jest.fn(async () => []) }));
jest.mock('@/lib/drainPendingViewers', () => ({ drainPendingViewers: jest.fn() }));

// ── expo-camera — permissions controlled per-test via the imported mock refs ──
// NOTE: jest.mock factories are hoisted before variable declarations, so we
// cannot reference external variables inside the factory.  Instead, we create
// jest.fn() inside the factory with a default denied state, then import the
// resulting mocks to override per-test with mockReturnValue.
jest.mock('expo-camera', () => ({
  CameraView:               () => null,
  useCameraPermissions:     jest.fn(() => [{ granted: false }, jest.fn()]),
  useMicrophonePermissions: jest.fn(() => [{ granted: false }, jest.fn()]),
}));

// ── react-native — hand-rolled host-component mock ───────────────────────────
jest.mock('react-native', () => {
  const React = require('react');

  const hostEl = (name: string) =>
    function MockRN({ children, ...rest }: any) {
      return React.createElement(name, rest, children);
    };

  // Animated.Value must be a constructible object with setValue so the
  // livePulse ref doesn't throw; loop/sequence/timing return objects whose
  // start/stop are no-ops.
  const animValue = () => ({ setValue: jest.fn(), _val: 1 });
  const Animated = {
    Value: jest.fn(animValue),
    View: hostEl('View'),
    loop:     jest.fn(() => ({ start: jest.fn(), stop: jest.fn() })),
    sequence: jest.fn(() => ({ start: jest.fn() })),
    timing:   jest.fn(() => ({ start: jest.fn() })),
  };

  return {
    View:              hostEl('View'),
    Text:              hostEl('Text'),
    ScrollView:        hostEl('ScrollView'),
    TouchableOpacity:  hostEl('TouchableOpacity'),
    ActivityIndicator: hostEl('ActivityIndicator'),
    FlatList: ({ data, renderItem, keyExtractor, ...rest }: any) =>
      React.createElement(
        'FlatList',
        rest,
        (data ?? []).map((item: any, idx: number) => {
          const key = keyExtractor ? keyExtractor(item, idx) : String(idx);
          return React.cloneElement(renderItem({ item, index: idx }), { key });
        }),
      ),
    StyleSheet: {
      create: (s: any) => s,
      flatten: (s: any) =>
        Array.isArray(s)
          ? Object.assign({}, ...s.filter(Boolean).map((x: any) => (Array.isArray(x) ? Object.assign({}, ...x) : x)))
          : s ?? {},
      absoluteFill: {},
      absoluteFillObject: {},
    },
    Modal:              ({ children, visible }: any) => visible ? React.createElement('Modal', {}, children) : null,
    Alert:              { alert: jest.fn() },
    Platform:           { OS: 'ios', select: (o: any) => o.ios ?? o.default },
    useWindowDimensions: jest.fn(() => ({ width: 390, height: 844 })),
    Animated,
    Share: { share: jest.fn(async () => ({ action: 'sharedAction' })) },
    PermissionsAndroid: {
      request: jest.fn(async () => 'granted'),
      PERMISSIONS: { BLUETOOTH_CONNECT: 'bluetooth' },
      RESULTS: { GRANTED: 'granted' },
    },
    ToastAndroid: { show: jest.fn(), LONG: 'long' },
  };
});

// ── Imports (after mocks) ─────────────────────────────────────────────────────
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import ScorekeeperScreen from '../app/scorekeeper';

// Typed references to the mocked permission hooks for per-test control.
const mockUseCameraPermissions = useCameraPermissions as jest.Mock;
const mockUseMicPermissions    = useMicrophonePermissions as jest.Mock;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Walk every node in a react-test-renderer JSON tree; collect matching nodes. */
function findNodes(node: any, test: (n: any) => boolean, acc: any[] = []): any[] {
  if (!node) return acc;
  if (Array.isArray(node)) { node.forEach((c) => findNodes(c, test, acc)); return acc; }
  if (typeof node !== 'object') return acc;
  if (test(node)) acc.push(node);
  if (node.children) findNodes(node.children, test, acc);
  return acc;
}

/** Return true if any text leaf in the tree equals the given string. */
function treeHasText(node: any, text: string): boolean {
  if (!node) return false;
  if (typeof node === 'string') return node === text;
  if (Array.isArray(node)) return node.some((c) => treeHasText(c, text));
  if (typeof node === 'object' && node.children) return treeHasText(node.children, text);
  return false;
}

// ── Setup ─────────────────────────────────────────────────────────────────────
beforeEach(() => {
  jest.clearAllMocks();
  mockWsInstance.onopen = null;
  mockWsInstance.onclose = null;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ScorekeeperScreen — Go Live button + LIVE badge', () => {

  // ── Test 1 ─────────────────────────────────────────────────────────────────

  describe('Go Live button when camera permission is denied', () => {

    test('is absent from the tree when camera permission is denied', async () => {
      // Denied camera, granted mic — cameraReady=false
      mockUseCameraPermissions.mockReturnValue([{ granted: false }, jest.fn()]);
      mockUseMicPermissions.mockReturnValue([{ granted: true  }, jest.fn()]);

      let tree!: renderer.ReactTestRenderer;
      await act(async () => { tree = renderer.create(<ScorekeeperScreen />); });

      // The Go Live button is identified by disabled={liveLoading} (false on
      // initial render) combined with activeOpacity={0.75} (camControl style).
      // The Save Game button also has disabled={false} but uses activeOpacity={0.8},
      // so the compound filter isolates only the Go Live button.
      // When cameraReady=false the entire camControls block is absent.
      const goLiveCandidates = findNodes(
        tree.toJSON(),
        (n) => n.type === 'TouchableOpacity'
          && n.props?.disabled === false
          && n.props?.activeOpacity === 0.75,
      );
      expect(goLiveCandidates).toHaveLength(0);
    });

    test('is absent from the tree when mic permission is denied', async () => {
      // Granted camera, denied mic — cameraReady=false
      mockUseCameraPermissions.mockReturnValue([{ granted: true  }, jest.fn()]);
      mockUseMicPermissions.mockReturnValue([{ granted: false }, jest.fn()]);

      let tree!: renderer.ReactTestRenderer;
      await act(async () => { tree = renderer.create(<ScorekeeperScreen />); });

      const goLiveCandidates = findNodes(
        tree.toJSON(),
        (n) => n.type === 'TouchableOpacity'
          && n.props?.disabled === false
          && n.props?.activeOpacity === 0.75,
      );
      expect(goLiveCandidates).toHaveLength(0);
    });

    test('is present when both camera and mic permissions are granted', async () => {
      // Both granted — cameraReady=true → camControls renders → Go Live visible
      mockUseCameraPermissions.mockReturnValue([{ granted: true }, jest.fn()]);
      mockUseMicPermissions.mockReturnValue([{ granted: true }, jest.fn()]);

      let tree!: renderer.ReactTestRenderer;
      await act(async () => { tree = renderer.create(<ScorekeeperScreen />); });

      const goLiveCandidates = findNodes(
        tree.toJSON(),
        (n) => n.type === 'TouchableOpacity'
          && n.props?.disabled === false
          && n.props?.activeOpacity === 0.75,
      );
      // Exactly one button matches: the Go Live button in camControls.
      expect(goLiveCandidates).toHaveLength(1);
    });

  });

  // ── Test 2 ─────────────────────────────────────────────────────────────────

  describe('LIVE badge in the collapsed previewHiddenOverlay', () => {

    async function buildLiveCollapsedTree(): Promise<renderer.ReactTestRenderer> {
      // Both permissions granted so camControls (and Go Live button) renders.
      mockUseCameraPermissions.mockReturnValue([{ granted: true }, jest.fn()]);
      mockUseMicPermissions.mockReturnValue([{ granted: true }, jest.fn()]);

      let tree!: renderer.ReactTestRenderer;
      await act(async () => { tree = renderer.create(<ScorekeeperScreen />); });

      // ── Step 1: press the Go Live button ──────────────────────────────────
      // Compound filter: disabled={false} (liveLoading=false) + activeOpacity=0.75
      // (camControl style). Save Game also has disabled={false} but uses 0.8.
      const [goLiveBtn] = findNodes(
        tree.toJSON(),
        (n) => n.type === 'TouchableOpacity'
          && n.props?.disabled === false
          && n.props?.activeOpacity === 0.75,
      );
      expect(goLiveBtn).toBeDefined();

      await act(async () => { goLiveBtn.props.onPress(); });

      // fetch('/api/live/start') has now resolved, isLive=true, liveCode='TESTLIVE'.
      // The Go Live button's style gains the red background — confirming state change.
      // ── Step 2: press the dismiss/eye-off button to collapse the preview ──
      // camControlBtn buttons all have activeOpacity={0.75}.
      // Order: [flip, mute, orientation, eye-off(dismiss), Go Live]  → index 3.
      const camCtrlBtns = findNodes(
        tree.toJSON(),
        (n) => n.type === 'TouchableOpacity' && n.props?.activeOpacity === 0.75,
      );
      // Must have at least the 5 camControl buttons.
      expect(camCtrlBtns.length).toBeGreaterThanOrEqual(5);

      const dismissBtn = camCtrlBtns[3]; // eye-off button (4th camControl)
      await act(async () => { dismissBtn.props.onPress(); });

      return tree;
    }

    test('LIVE badge renders inside the collapsed overlay after broadcast starts', async () => {
      const tree = await buildLiveCollapsedTree();
      // The previewHiddenOverlay renders {isLive && <LIVE badge>} which contains
      // the text "LIVE".  It must survive the preview collapse.
      expect(treeHasText(tree.toJSON(), 'LIVE')).toBe(true);
    });

    test('no LIVE badge is shown in the collapsed overlay when not streaming', async () => {
      // Permissions granted but Go Live never pressed — previewVisible toggled directly.
      mockUseCameraPermissions.mockReturnValue([{ granted: true }, jest.fn()]);
      mockUseMicPermissions.mockReturnValue([{ granted: true }, jest.fn()]);

      let tree!: renderer.ReactTestRenderer;
      await act(async () => { tree = renderer.create(<ScorekeeperScreen />); });

      // Press eye-off (dismiss) without going live first.
      const camCtrlBtns = findNodes(
        tree.toJSON(),
        (n) => n.type === 'TouchableOpacity' && n.props?.activeOpacity === 0.75,
      );
      const dismissBtn = camCtrlBtns[3];
      await act(async () => { dismissBtn.props.onPress(); });

      // isLive=false → LIVE badge must not appear.
      expect(treeHasText(tree.toJSON(), 'LIVE')).toBe(false);
    });

    test('fetch is called with /api/live/start when Go Live is pressed', async () => {
      await buildLiveCollapsedTree();
      const calls = ((global as any).fetch as jest.Mock).mock.calls;
      const liveCall = calls.find(([url]: [string]) => String(url).includes('/api/live/start'));
      expect(liveCall).toBeDefined();
    });

  });

});
