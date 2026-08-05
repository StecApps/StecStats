/**
 * Regression guard: dashboard theme wiring
 *
 * Two layers of protection:
 *
 * 1. STATIC — reads index.tsx as text and asserts the known hex tokens for
 *    primary (#FF531A), background (#0C0A09), and muted-foreground (#B7B2AE)
 *    do not appear as hardcoded string literals.  A re-introduced local
 *    BRAND constant or copy-pasted hex will break this test.
 *
 * 2. RUNTIME — mutates colors.dark.primary to a sentinel value (#00CCFF)
 *    before rendering, then verifies that:
 *      • The arc gauge filled-arc stroke equals the sentinel.
 *      • A selected player chip's backgroundColor equals the sentinel.
 *      • The hero card borderColor is the rgba() form of the sentinel.
 *
 *    Because useColors() reads colors.dark at call time and primaryRgba() is a
 *    closure over colors.dark.primary, all three sites reflect the mutation
 *    without any module re-import.
 */

// ── External / native mocks (hoisted before imports) ─────────────────────────

jest.mock('@clerk/clerk-expo', () => ({
  useAuth: jest.fn(() => ({
    getToken: jest.fn(() => Promise.resolve('test-token')),
    userId: 'test-user-id',
  })),
}));

jest.mock('expo-router', () => ({
  useRouter: jest.fn(() => ({ back: jest.fn() })),
}));

jest.mock('@workspace/api-client-react', () => ({
  useGetPlayerSummary: jest.fn(() => ({
    data: {
      games: 10,
      wins: 6,
      losses: 4,
      points: 200,
      ppg: 20.0,
      rebounds: 80,
      rpg: 8.0,
      assists: 40,
      apg: 4.0,
      steals: 10,
      spg: 1.0,
      blocks: 5,
      bpg: 0.5,
      turnovers: 15,
      topg: 1.5,
      twoMade: 60,
      twoAttempted: 120,
      threeMade: 20,
      threeAttempted: 50,
      ftMade: 40,
      ftAttempted: 50,
      seasonScope: 'season',
    },
    isLoading: false,
  })),
  useListPlayers: jest.fn(() => ({
    data: [{ id: 1, name: 'Alice Test', photoObjectPath: null }],
    isLoading: false,
    refetch: jest.fn(),
  })),
  useUpdatePlayer: jest.fn(() => ({ mutateAsync: jest.fn() })),
  getListPlayersQueryKey: jest.fn(() => ['players']),
}));

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: jest.fn(() => ({ invalidateQueries: jest.fn() })),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: jest.fn(() => ({ top: 0, bottom: 0, left: 0, right: 0 })),
}));

jest.mock('expo-linear-gradient', () => {
  const React = require('react');
  return {
    LinearGradient: ({ children, colors: _c, ...rest }: any) =>
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
  const MockSvg = ({ children, ...rest }: any) =>
    React.createElement('Svg', rest, children);
  const MockCircle = (props: any) => React.createElement('Circle', props);
  const MockG = ({ children, ...rest }: any) =>
    React.createElement('G', rest, children);
  return {
    __esModule: true,
    default: MockSvg,
    Svg: MockSvg,
    Circle: MockCircle,
    G: MockG,
  };
});

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

jest.mock('react-native', () => {
  const React = require('react');
  const hostEl = (name: string) =>
    function MockRN({ children, ...rest }: any) {
      return React.createElement(name, rest, children);
    };
  return {
    View: hostEl('View'),
    Text: hostEl('Text'),
    ScrollView: hostEl('ScrollView'),
    TouchableOpacity: hostEl('TouchableOpacity'),
    ActivityIndicator: hostEl('ActivityIndicator'),
    RefreshControl: hostEl('RefreshControl'),
    StyleSheet: {
      create: (s: any) => s,
      flatten: (s: any) => (Array.isArray(s) ? Object.assign({}, ...s.map((x: any) => x ?? {})) : s ?? {}),
      absoluteFill: {},
      absoluteFillObject: {},
    },
    Alert: { alert: jest.fn() },
    Platform: { OS: 'ios', select: (o: any) => o.ios ?? o.default },
  };
});

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import React from 'react';
import renderer, { act } from 'react-test-renderer';
import * as fs from 'fs';
import * as path from 'path';
import colors from '@/constants/colors';
// Static import — useColors() and primaryRgba() both read colors.dark at
// call-time (not at module-load), so mutating colors.dark.primary before
// rendering is sufficient to propagate the sentinel through all three sites.
import DashboardScreen from '../app/(tabs)/index';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Convert a 6-char hex to rgba(r,g,b,alpha) — mirrors hexToRgba in index.tsx. */
function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * Walk a react-test-renderer JSON tree, calling visitor on every node.
 * Returns the array of every node for which visitor returns true.
 */
function findNodes(
  node: any,
  visitor: (n: any) => boolean,
  results: any[] = [],
): any[] {
  if (!node) return results;
  if (Array.isArray(node)) {
    node.forEach((child) => findNodes(child, visitor, results));
    return results;
  }
  if (typeof node === 'object') {
    if (visitor(node)) results.push(node);
    if (node.children) findNodes(node.children, visitor, results);
  }
  return results;
}

/** Flatten a style prop (plain object or array of objects) into one object. */
function flatStyle(style: any): Record<string, any> {
  if (!style) return {};
  if (Array.isArray(style))
    return Object.assign({}, ...style.map((s: any) => flatStyle(s)));
  return style;
}

// ── 1. Static source checks ───────────────────────────────────────────────────

describe('Dashboard index.tsx — no hardcoded theme hex literals', () => {
  const srcPath = path.resolve(__dirname, '../app/(tabs)/index.tsx');
  const rawSrc = fs.readFileSync(srcPath, 'utf8');

  // Strip single-line comments before scanning so a comment that mentions a
  // hex value (for documentation) doesn't cause a false positive.
  const strippedSrc = rawSrc
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');

  test('primary color (#FF531A) is not hardcoded — must come from colors.ts', () => {
    expect(strippedSrc).not.toMatch(/'#FF531A'/i);
    expect(strippedSrc).not.toMatch(/"#FF531A"/i);
  });

  test('background color (#0C0A09) is not hardcoded — must come from colors.ts', () => {
    expect(strippedSrc).not.toMatch(/'#0C0A09'/i);
    expect(strippedSrc).not.toMatch(/"#0C0A09"/i);
  });

  test('muted-foreground color (#B7B2AE) is not hardcoded — must come from colors.ts', () => {
    expect(strippedSrc).not.toMatch(/'#B7B2AE'/i);
    expect(strippedSrc).not.toMatch(/"#B7B2AE"/i);
  });
});

// ── 2. Runtime wiring checks ──────────────────────────────────────────────────

describe('Dashboard runtime — theme tokens flow from colors.dark.primary', () => {
  const SENTINEL = '#00CCFF'; // visually distinct from the real primary (#FF531A)
  const ORIGINAL = colors.dark.primary;

  let tree: renderer.ReactTestRenderer;

  beforeAll(async () => {
    // Mutate the live module object.  useColors() spreads colors.dark at call
    // time, and primaryRgba() closes over colors.dark.primary at call time
    // (not at module-load), so all colour reads in the next render will see
    // SENTINEL without needing a module re-import.
    colors.dark.primary = SENTINEL;
    colors.dark.tint = SENTINEL;
    colors.dark.ring = SENTINEL;

    await act(async () => {
      tree = renderer.create(<DashboardScreen />);
    });
  });

  afterAll(() => {
    // Restore so other test suites aren't affected.
    colors.dark.primary = ORIGINAL;
    colors.dark.tint = ORIGINAL;
    colors.dark.ring = ORIGINAL;
    jest.resetModules();
  });

  // ── 2a. Arc gauge stroke ──────────────────────────────────────────────────

  test('arc gauge filled-arc stroke matches colors.dark.primary (not a hardcoded hex)', () => {
    const json = tree.toJSON();
    // The filled arc is a Circle with strokeDasharray set (background circle
    // has no strokeDasharray / dash pattern).
    const filledArcs = findNodes(
      json,
      (n) =>
        n.type === 'Circle' &&
        n.props?.strokeDasharray != null &&
        !n.props.strokeDasharray.startsWith('0 '), // exclude empty arcs
    );

    expect(filledArcs.length).toBeGreaterThan(0);
    filledArcs.forEach((arc) => {
      expect(arc.props.stroke).toBe(SENTINEL);
    });
  });

  // ── 2b. Selected chip background ─────────────────────────────────────────

  test('selected player chip backgroundColor reflects colors.dark.primary', () => {
    const json = tree.toJSON();
    // PlayerChip renders a TouchableOpacity whose style includes
    // backgroundColor: c.primary when isSelected.  The first player is
    // auto-selected (activeId = players[0].id).
    const chips = findNodes(
      json,
      (n) => n.type === 'TouchableOpacity' && flatStyle(n.props?.style)?.backgroundColor === SENTINEL,
    );

    expect(chips.length).toBeGreaterThan(0);
  });

  // ── 2c. Hero card border ──────────────────────────────────────────────────

  test('hero card borderColor is rgba() derived from colors.dark.primary', () => {
    const json = tree.toJSON();
    const expectedBorder = hexToRgba(SENTINEL, 0.4);

    // heroS.card is applied as [heroS.card, { borderColor: primaryRgba(0.40), ... }]
    const heroCards = findNodes(
      json,
      (n) => {
        const s = flatStyle(n.props?.style);
        return s?.borderColor === expectedBorder;
      },
    );

    expect(heroCards.length).toBeGreaterThan(0);
  });
});
