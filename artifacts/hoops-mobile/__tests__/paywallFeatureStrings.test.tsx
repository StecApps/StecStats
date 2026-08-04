/**
 * Render smoke-test for the paywall screen.
 *
 * Asserts that every feature string from @workspace/plan-copy
 * (FREE_FEATURES, PRO_FEATURES, PREMIUM_FEATURES) appears in the rendered
 * component tree.  The real plan-copy module is intentionally NOT mocked so
 * that any copy change automatically re-verifies all three tiers.
 */

// ── Mocks (hoisted before imports) ───────────────────────────────────────────

jest.mock('expo-router', () => ({
  useRouter: jest.fn(() => ({ back: jest.fn() })),
}));

jest.mock('@/hooks/useColors', () => ({
  useColors: jest.fn(() => ({
    background: '#000',
    foreground: '#fff',
    primary: '#f97316',
    card: '#111',
    border: '#333',
    muted: '#222',
    mutedForeground: '#888',
    destructive: '#ef4444',
    input: '#111',
  })),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: jest.fn(() => ({ top: 0, bottom: 0, left: 0, right: 0 })),
}));

jest.mock('@/lib/revenuecat', () => ({
  useSubscription: jest.fn(() => ({
    offerings: null,
    purchase: jest.fn(),
    restore: jest.fn(),
    isPurchasing: false,
    isRestoring: false,
    isPro: false,
    isPremium: false,
    configured: false,
  })),
}));

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(),
  notificationAsync: jest.fn(),
  ImpactFeedbackStyle: { Medium: 'medium' },
  NotificationFeedbackType: { Success: 'success' },
}));

jest.mock('@expo/vector-icons', () => ({
  Ionicons: () => null,
}));

jest.mock('expo-image', () => ({
  Image: () => null,
}));

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: jest.fn(() => ({ invalidateQueries: jest.fn() })),
}));

jest.mock('@workspace/api-client-react', () => ({
  getGetBillingStatusQueryKey: jest.fn(() => ['billing-status']),
}));

jest.mock('react-native', () => {
  const React = require('react');

  const hostEl = (name: string) =>
    function MockRNComponent({ children, ...rest }: any) {
      return React.createElement(name, rest, children);
    };

  return {
    View: hostEl('View'),
    Text: hostEl('Text'),
    ScrollView: hostEl('ScrollView'),
    TouchableOpacity: hostEl('TouchableOpacity'),
    ActivityIndicator: hostEl('ActivityIndicator'),
    StyleSheet: {
      create: (s: any) => s,
      flatten: (s: any) => s,
      absoluteFill: {},
      absoluteFillObject: {},
    },
    Alert: { alert: jest.fn() },
    Platform: { OS: 'ios', select: (o: any) => o.ios ?? o.default },
  };
});

// ── Imports (after mock hoisting) ─────────────────────────────────────────────
import React from 'react';
import renderer, { act } from 'react-test-renderer';

import { FREE_FEATURES, PRO_FEATURES, PREMIUM_FEATURES } from '@workspace/plan-copy';
import PaywallScreen from '../app/paywall';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Recursively search a react-test-renderer JSON tree for a text leaf. */
function treeContainsText(node: any, text: string): boolean {
  if (!node) return false;
  if (typeof node === 'string') return node === text;
  if (Array.isArray(node)) return node.some((n) => treeContainsText(n, text));
  if (node.children) return treeContainsText(node.children, text);
  return false;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PaywallScreen — plan-copy feature strings', () => {
  let tree: renderer.ReactTestRenderer;

  beforeAll(async () => {
    await act(async () => {
      tree = renderer.create(<PaywallScreen />);
    });
  });

  describe('FREE tier features', () => {
    FREE_FEATURES.forEach((feature) => {
      test(`renders "${feature}"`, () => {
        expect(treeContainsText(tree.toJSON(), feature)).toBe(true);
      });
    });
  });

  describe('PRO tier features', () => {
    PRO_FEATURES.forEach((feature) => {
      test(`renders "${feature}"`, () => {
        expect(treeContainsText(tree.toJSON(), feature)).toBe(true);
      });
    });
  });

  describe('PREMIUM tier features', () => {
    PREMIUM_FEATURES.forEach((feature) => {
      test(`renders "${feature}"`, () => {
        expect(treeContainsText(tree.toJSON(), feature)).toBe(true);
      });
    });
  });
});
