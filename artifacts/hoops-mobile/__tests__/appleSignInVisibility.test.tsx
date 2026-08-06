/**
 * Regression guard: Apple Sign-In button visibility
 *
 * The Apple Sign-In button must only appear when
 * `AppleAuthentication.isAvailableAsync()` returns true — which only
 * happens on a real iOS dev/production build. Two scenarios must stay
 * hidden:
 *
 *   1. Android  — Platform.OS !== 'ios' so isAvailableAsync is never
 *      called; appleAvailable stays false.
 *
 *   2. Expo Go on iOS — Platform.OS === 'ios' but isAvailableAsync()
 *      returns false; appleAvailable stays false.
 *
 * A third scenario verifies the positive case:
 *
 *   3. Real iOS dev build — isAvailableAsync() returns true; button
 *      renders.
 *
 * Tapping the button when unavailable would crash Expo Go or show a
 * broken UI on Android, so this guard must never regress.
 */

// ── Shared mocks (always hoisted) ────────────────────────────────────────────

jest.mock('@clerk/clerk-expo', () => ({
  useSignIn: jest.fn(() => ({
    signIn: {},
    setActive: jest.fn(),
    isLoaded: true,
  })),
  useSignUp: jest.fn(() => ({
    signUp: {},
    setActive: jest.fn(),
    isLoaded: true,
  })),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: jest.fn(() => ({ top: 0, bottom: 0, left: 0, right: 0 })),
}));

jest.mock('expo-image', () => ({ Image: () => null }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('expo-haptics', () => ({
  notificationAsync: jest.fn(),
  NotificationFeedbackType: { Success: 'success', Error: 'error' },
}));

// expo-apple-authentication is mocked per-suite via mockImplementation so we
// register a default here and override below.
const mockIsAvailableAsync = jest.fn();
const MockAppleButton = jest.fn((_props: any) => null);

jest.mock('expo-apple-authentication', () => ({
  isAvailableAsync: (...args: any[]) => mockIsAvailableAsync(...args),
  AppleAuthenticationButton: (...args: any[]) => MockAppleButton(...args),
  AppleAuthenticationButtonType: { SIGN_IN: 'SIGN_IN' },
  AppleAuthenticationButtonStyle: { BLACK: 'BLACK', WHITE: 'WHITE' },
  AppleAuthenticationScope: { FULL_NAME: 'FULL_NAME', EMAIL: 'EMAIL' },
}));

// react-native is mocked per-suite to control Platform.OS.
// We set a module-level default and override per describe block.
let mockPlatformOS = 'ios';

jest.mock('react-native', () => {
  const React = require('react');
  const hostEl = (name: string) =>
    function MockRN({ children, ...rest }: any) {
      return React.createElement(name, rest, children ?? null);
    };
  return {
    View: hostEl('View'),
    Text: hostEl('Text'),
    TextInput: hostEl('TextInput'),
    ScrollView: hostEl('ScrollView'),
    TouchableOpacity: hostEl('TouchableOpacity'),
    KeyboardAvoidingView: hostEl('KeyboardAvoidingView'),
    ActivityIndicator: hostEl('ActivityIndicator'),
    StyleSheet: {
      create: (s: any) => s,
      flatten: (s: any) =>
        Array.isArray(s) ? Object.assign({}, ...s.map((x: any) => x ?? {})) : s ?? {},
      absoluteFill: {},
      absoluteFillObject: {},
    },
    Platform: {
      get OS() {
        return mockPlatformOS;
      },
      select: (o: any) => (mockPlatformOS === 'ios' ? (o.ios ?? o.default) : (o.android ?? o.default)),
    },
    useColorScheme: jest.fn(() => 'dark'),
  };
});

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import React from 'react';
import renderer, { act } from 'react-test-renderer';
import AuthScreen from '../app/(auth)/index';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Walk the renderer JSON tree and collect every node matching `predicate`. */
function findNodes(node: any, predicate: (n: any) => boolean, acc: any[] = []): any[] {
  if (!node) return acc;
  if (Array.isArray(node)) {
    node.forEach((child) => findNodes(child, predicate, acc));
    return acc;
  }
  if (typeof node === 'object') {
    if (predicate(node)) acc.push(node);
    if (node.children) findNodes(node.children, predicate, acc);
  }
  return acc;
}

/**
 * Returns true if MockAppleButton was invoked during the render.
 *
 * MockAppleButton returns null, so it leaves no node in the JSON tree — we
 * must detect rendering through the mock's call record instead of inspecting
 * the tree structure.
 */
function wasAppleButtonRendered(): boolean {
  return MockAppleButton.mock.calls.length > 0;
}

// ── Suite 1: Android ──────────────────────────────────────────────────────────

describe('AuthScreen — Apple button on Android', () => {
  beforeAll(() => {
    mockPlatformOS = 'android';
    // isAvailableAsync should never be called on Android, but if it is,
    // returning false is the safe fallback.
    mockIsAvailableAsync.mockResolvedValue(false);
    MockAppleButton.mockReturnValue(null);
  });

  afterAll(() => {
    jest.clearAllMocks();
  });

  test('Apple Sign-In button is absent on Android', async () => {
    MockAppleButton.mockClear();
    await act(async () => {
      renderer.create(<AuthScreen />);
    });

    expect(wasAppleButtonRendered()).toBe(false);
  });

  test('isAvailableAsync is never called on Android', async () => {
    mockIsAvailableAsync.mockClear();

    await act(async () => {
      renderer.create(<AuthScreen />);
    });

    expect(mockIsAvailableAsync).not.toHaveBeenCalled();
  });
});

// ── Suite 2: Expo Go on iOS (isAvailableAsync → false) ───────────────────────

describe('AuthScreen — Apple button in Expo Go (iOS, isAvailableAsync = false)', () => {
  beforeAll(() => {
    mockPlatformOS = 'ios';
    mockIsAvailableAsync.mockResolvedValue(false);
    MockAppleButton.mockReturnValue(null);
  });

  afterAll(() => {
    jest.clearAllMocks();
  });

  test('Apple Sign-In button is absent when isAvailableAsync returns false', async () => {
    MockAppleButton.mockClear();
    await act(async () => {
      renderer.create(<AuthScreen />);
    });

    expect(wasAppleButtonRendered()).toBe(false);
  });

  test('isAvailableAsync is called once on iOS', async () => {
    mockIsAvailableAsync.mockClear();
    mockIsAvailableAsync.mockResolvedValue(false);

    await act(async () => {
      renderer.create(<AuthScreen />);
    });

    expect(mockIsAvailableAsync).toHaveBeenCalledTimes(1);
  });
});

// ── Suite 3: Real iOS dev build (isAvailableAsync → true) ────────────────────

describe('AuthScreen — Apple button on real iOS build (isAvailableAsync = true)', () => {
  beforeAll(() => {
    mockPlatformOS = 'ios';
    mockIsAvailableAsync.mockResolvedValue(true);
    MockAppleButton.mockReturnValue(null);
  });

  afterAll(() => {
    jest.clearAllMocks();
  });

  test('Apple Sign-In button is present when isAvailableAsync returns true', async () => {
    MockAppleButton.mockClear();
    await act(async () => {
      renderer.create(<AuthScreen />);
    });

    expect(wasAppleButtonRendered()).toBe(true);
  });
});
