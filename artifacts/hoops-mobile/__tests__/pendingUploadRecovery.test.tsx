/**
 * Tests for PendingUploadBanner — the Games screen component that surfaces a
 * stuck upload and lets a coach resume, save without video, or discard.
 *
 * Covered scenarios:
 *   1. Banner renders with team name, opponent, score, and formatted date.
 *   2. "Resume upload" (single clip) — uploadVideoFile called once, saveGame
 *      receives the returned path + full stats, AsyncStorage marker cleared.
 *   3. "Resume upload" (multi-clip) — uploadVideoFile called twice, concat
 *      endpoint called with both paths, saveGame receives the merged path.
 *   4. "Save without video" — uploadVideoFile not called, saveGame called with
 *      null video path + full stats, marker cleared.
 *   5. Upload failure — Alert.alert called, AsyncStorage marker NOT removed.
 */

// ── Mocks (hoisted before imports) ───────────────────────────────────────────

jest.mock('react-native', () => ({
  Alert: { alert: jest.fn() },
  Platform: { OS: 'ios' },
  View: 'View',
  Text: 'Text',
  TouchableOpacity: 'TouchableOpacity',
  ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (s: any) => s },
  FlatList: 'FlatList',
  TextInput: 'TextInput',
  RefreshControl: 'RefreshControl',
  Modal: 'Modal',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));

// In-memory AsyncStorage — must be prefixed with "mock" for Jest hoisting.
let mockAsyncStore: Record<string, string> = {};
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem:    jest.fn(async (k: string) => mockAsyncStore[k] ?? null),
    setItem:    jest.fn(async (k: string, v: string) => { mockAsyncStore[k] = v; }),
    removeItem: jest.fn(async (k: string) => { delete mockAsyncStore[k]; }),
  },
}));

jest.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));

jest.mock('@/hooks/useColors', () => ({
  useColors: jest.fn(() => ({
    primary: '#FF531A',
    foreground: '#fff',
    mutedForeground: '#aaa',
    border: '#333',
    background: '#000',
    card: '#111',
    secondary: '#222',
  })),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

jest.mock('expo-router', () => ({
  useRouter:            jest.fn(() => ({ replace: jest.fn(), push: jest.fn() })),
  useFocusEffect:       jest.fn(),
  useLocalSearchParams: jest.fn(() => ({})),
}));

jest.mock('@workspace/api-client-react', () => ({
  useListTeams:        jest.fn(() => ({ data: [], isLoading: false })),
  useListTeamGames:    jest.fn(() => ({ data: [], isLoading: false })),
  useListPlayers:      jest.fn(() => ({ data: [], isLoading: false })),
  useCreateGame:       jest.fn(() => ({ mutateAsync: jest.fn() })),
  useRequestUploadUrl: jest.fn(() => ({ mutateAsync: jest.fn() })),
}));

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: jest.fn(() => ({ invalidateQueries: jest.fn() })),
}));

jest.mock('@clerk/expo', () => ({
  useAuth: jest.fn(() => ({ getToken: jest.fn(async () => 'tok') })),
}));

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
  Feather:  'Feather',
}));

jest.mock('@/lib/tekoStyle', () => ({ tekoStyle: jest.fn(() => ({})) }));

jest.mock('@/lib/ScreenBackground', () => ({
  ScreenGlow:          'ScreenGlow',
  BasketballWatermark: 'BasketballWatermark',
}));

// @/app/scorekeeper has complex camera/AV imports — return just the constants.
jest.mock('@/app/scorekeeper', () => ({
  PENDING_UPLOAD_KEY: 'stec:pending-mobile-upload',
}));

jest.mock('@/lib/uploadVideoFile', () => ({
  uploadVideoFile:      jest.fn(),
  UPLOAD_CANCELLED_MSG: 'Upload cancelled',
}));

jest.mock('@/lib/saveGame', () => ({
  saveGame: jest.fn(),
}));

// ── Imports (after hoisting) ──────────────────────────────────────────────────

import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth } from '@clerk/expo';
import { useCreateGame, useRequestUploadUrl } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { uploadVideoFile } from '@/lib/uploadVideoFile';
import { saveGame } from '@/lib/saveGame';
import { PendingUploadBanner } from '../app/(tabs)/games';

const PENDING_UPLOAD_KEY = 'stec:pending-mobile-upload';

const alertSpy                = Alert.alert as jest.Mock;
const mockUploadVideo         = uploadVideoFile as jest.Mock;
const mockSaveGame            = saveGame as jest.Mock;
const mockUseAuth             = useAuth as jest.Mock;
const mockUseCreateGame       = useCreateGame as jest.Mock;
const mockUseRequestUploadUrl = useRequestUploadUrl as jest.Mock;
const mockUseQueryClient      = useQueryClient as jest.Mock;

// ── Fixtures ──────────────────────────────────────────────────────────────────

import type { StatLine, GameEvent } from '../lib/saveGame';

const STAT_LINE_1: StatLine = {
  ftMade: 2, ftAttempted: 4,
  twoMade: 3, twoAttempted: 6,
  threeMade: 1, threeAttempted: 3,
  assists: 2, rebounds: 4,
  steals: 1, turnovers: 1, blocks: 0,
};

const STAT_LINE_2: StatLine = {
  ftMade: 0, ftAttempted: 2,
  twoMade: 5, twoAttempted: 8,
  threeMade: 2, threeAttempted: 4,
  assists: 3, rebounds: 6,
  steals: 2, turnovers: 0, blocks: 1,
};

const EVENTS: GameEvent[] = [
  { playerId: 1, statField: 'twoMade',  delta: 1, videoTimestampMs: 12000 },
  { playerId: 2, statField: 'assists',  delta: 1, videoTimestampMs: 34500 },
];

function makePending(uris: string[] = ['file:///clip1.mp4']) {
  return {
    uris,
    teamId: 7,
    teamName: 'Warriors',
    opponent: 'Lakers',
    date: '2026-08-04',
    teamScore: 82,
    opponentScore: 75,
    stats: { 1: STAT_LINE_1, 2: STAT_LINE_2 },
    events: EVENTS,
    savedAt: new Date().toISOString(),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Recursively extract all text content from a react-test-renderer node tree.
 * Avoids JSON.stringify which throws on the circular FiberNode references.
 */
function getNodeText(node: any): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(getNodeText).join('');
  if (node && typeof node === 'object' && node.children) {
    return (node.children as any[]).map(getNodeText).join('');
  }
  return '';
}

/** Find a TouchableOpacity whose rendered text contains the given label. */
function findButton(tree: renderer.ReactTestRenderer, label: string) {
  return tree.root.findAll(
    (node) => node.type === 'TouchableOpacity' && getNodeText(node).includes(label),
  )[0];
}

/** Seed AsyncStorage with a PendingUpload fixture. */
function seed(uris: string[] = ['file:///clip1.mp4']) {
  mockAsyncStore[PENDING_UPLOAD_KEY] = JSON.stringify(makePending(uris));
}

/**
 * Wire saveGame to simulate a successful save: it calls deps.routerReplace,
 * which is what the real saveGame does — and the banner's routerReplace clears
 * AsyncStorage and collapses the banner.
 */
function wireSuccessfulSave() {
  mockSaveGame.mockImplementation(async (_videoPath: string | null, deps: any) => {
    await deps.routerReplace('/game/1');
  });
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockAsyncStore = {};

  mockUseAuth.mockReturnValue({ getToken: jest.fn(async () => 'tok') });
  mockUseCreateGame.mockReturnValue({ mutateAsync: jest.fn().mockResolvedValue({ id: 1 }) });
  mockUseRequestUploadUrl.mockReturnValue({ mutateAsync: jest.fn() });
  mockUseQueryClient.mockReturnValue({ invalidateQueries: jest.fn() });

  // Default: single-clip upload resolves to a path.
  mockUploadVideo.mockResolvedValue('videos/clip.mp4');
});

// ═════════════════════════════════════════════════════════════════════════════
// 1. Banner-render test
// ═════════════════════════════════════════════════════════════════════════════

describe('PendingUploadBanner — renders with correct metadata', () => {
  test('shows team name, opponent, score, and formatted date from the seeded record', async () => {
    seed();
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<PendingUploadBanner onDismiss={jest.fn()} />);
    });

    const json = JSON.stringify(tree.toJSON());
    expect(json).toContain('Warriors');
    expect(json).toContain('Lakers');
    expect(json).toContain('82');
    expect(json).toContain('75');
    // The date '2026-08-04' should appear as some form of Aug 4.
    expect(json).toMatch(/Aug|8/);
    expect(json).toMatch(/4/);
  });

  test('returns null when there is no pending upload', async () => {
    // AsyncStorage store is empty.
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<PendingUploadBanner onDismiss={jest.fn()} />);
    });

    expect(tree.toJSON()).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Single-clip resume test
// ═════════════════════════════════════════════════════════════════════════════

describe('PendingUploadBanner — "Resume upload" single clip', () => {
  test('calls uploadVideoFile once with the seeded URI', async () => {
    seed(['file:///clip1.mp4']);
    wireSuccessfulSave();

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<PendingUploadBanner onDismiss={jest.fn()} />);
    });

    await act(async () => { findButton(tree, 'Resume upload').props.onPress(); });

    expect(mockUploadVideo).toHaveBeenCalledTimes(1);
    expect(mockUploadVideo.mock.calls[0][0]).toBe('file:///clip1.mp4');
  });

  test('calls saveGame with the uploaded video path and all stats/events', async () => {
    seed(['file:///clip1.mp4']);
    wireSuccessfulSave();

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<PendingUploadBanner onDismiss={jest.fn()} />);
    });

    await act(async () => { findButton(tree, 'Resume upload').props.onPress(); });

    expect(mockSaveGame).toHaveBeenCalledTimes(1);
    const [videoPath, deps] = mockSaveGame.mock.calls[0];
    expect(videoPath).toBe('videos/clip.mp4');
    expect(deps.teamScore).toBe(82);
    expect(deps.opponentScore).toBe(75);
    expect(deps.stats).toEqual({ 1: STAT_LINE_1, 2: STAT_LINE_2 });
    expect(deps.events).toEqual(EVENTS);
    expect(deps.opponent).toBe('Lakers');
    expect(deps.date).toBe('2026-08-04');
  });

  test('removes the AsyncStorage marker after saveGame resolves', async () => {
    seed(['file:///clip1.mp4']);
    wireSuccessfulSave();

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<PendingUploadBanner onDismiss={jest.fn()} />);
    });

    await act(async () => { findButton(tree, 'Resume upload').props.onPress(); });

    expect(AsyncStorage.removeItem).toHaveBeenCalledWith(PENDING_UPLOAD_KEY);
    expect(mockAsyncStore[PENDING_UPLOAD_KEY]).toBeUndefined();
  });

  test('banner disappears and calls onDismiss after successful save', async () => {
    seed(['file:///clip1.mp4']);
    wireSuccessfulSave();

    const onDismiss = jest.fn();
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<PendingUploadBanner onDismiss={onDismiss} />);
    });

    await act(async () => { findButton(tree, 'Resume upload').props.onPress(); });

    expect(tree.toJSON()).toBeNull();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Multi-clip resume test
// ═════════════════════════════════════════════════════════════════════════════

describe('PendingUploadBanner — "Resume upload" multi-clip path', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => ({ videoObjectPath: 'videos/merged.mp4' }),
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('calls uploadVideoFile twice for two URIs', async () => {
    seed(['file:///clip1.mp4', 'file:///clip2.mp4']);
    mockUploadVideo
      .mockResolvedValueOnce('videos/clip1.mp4')
      .mockResolvedValueOnce('videos/clip2.mp4');
    wireSuccessfulSave();

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<PendingUploadBanner onDismiss={jest.fn()} />);
    });

    await act(async () => { findButton(tree, 'Resume upload').props.onPress(); });

    expect(mockUploadVideo).toHaveBeenCalledTimes(2);
    expect(mockUploadVideo.mock.calls[0][0]).toBe('file:///clip1.mp4');
    expect(mockUploadVideo.mock.calls[1][0]).toBe('file:///clip2.mp4');
  });

  test('calls the concat endpoint with both uploaded segment paths', async () => {
    seed(['file:///clip1.mp4', 'file:///clip2.mp4']);
    mockUploadVideo
      .mockResolvedValueOnce('videos/clip1.mp4')
      .mockResolvedValueOnce('videos/clip2.mp4');
    wireSuccessfulSave();

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<PendingUploadBanner onDismiss={jest.fn()} />);
    });

    await act(async () => { findButton(tree, 'Resume upload').props.onPress(); });

    const fetchMock = global.fetch as jest.Mock;
    const concatCall = fetchMock.mock.calls.find(([url]: [string]) =>
      url.includes('/api/storage/concat-segments'),
    );
    expect(concatCall).toBeDefined();
    const body = JSON.parse(concatCall[1].body);
    expect(body.segmentPaths).toEqual(['videos/clip1.mp4', 'videos/clip2.mp4']);
  });

  test('passes the merged path from the concat response to saveGame', async () => {
    seed(['file:///clip1.mp4', 'file:///clip2.mp4']);
    mockUploadVideo
      .mockResolvedValueOnce('videos/clip1.mp4')
      .mockResolvedValueOnce('videos/clip2.mp4');
    wireSuccessfulSave();

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<PendingUploadBanner onDismiss={jest.fn()} />);
    });

    await act(async () => { findButton(tree, 'Resume upload').props.onPress(); });

    expect(mockSaveGame).toHaveBeenCalledTimes(1);
    expect(mockSaveGame.mock.calls[0][0]).toBe('videos/merged.mp4');
  });

  test('clears the AsyncStorage marker after a successful multi-clip save', async () => {
    seed(['file:///clip1.mp4', 'file:///clip2.mp4']);
    mockUploadVideo
      .mockResolvedValueOnce('videos/clip1.mp4')
      .mockResolvedValueOnce('videos/clip2.mp4');
    wireSuccessfulSave();

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<PendingUploadBanner onDismiss={jest.fn()} />);
    });

    await act(async () => { findButton(tree, 'Resume upload').props.onPress(); });

    expect(AsyncStorage.removeItem).toHaveBeenCalledWith(PENDING_UPLOAD_KEY);
    expect(mockAsyncStore[PENDING_UPLOAD_KEY]).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. "Save without video" test
// ═════════════════════════════════════════════════════════════════════════════

describe('PendingUploadBanner — "Save without video"', () => {
  test('does not call uploadVideoFile', async () => {
    seed();
    wireSuccessfulSave();

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<PendingUploadBanner onDismiss={jest.fn()} />);
    });

    await act(async () => { findButton(tree, 'Save without video').props.onPress(); });

    expect(mockUploadVideo).not.toHaveBeenCalled();
  });

  test('calls saveGame with null as the video path', async () => {
    seed();
    wireSuccessfulSave();

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<PendingUploadBanner onDismiss={jest.fn()} />);
    });

    await act(async () => { findButton(tree, 'Save without video').props.onPress(); });

    expect(mockSaveGame).toHaveBeenCalledTimes(1);
    expect(mockSaveGame.mock.calls[0][0]).toBeNull();
  });

  test('passes full stats and events to saveGame', async () => {
    seed();
    wireSuccessfulSave();

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<PendingUploadBanner onDismiss={jest.fn()} />);
    });

    await act(async () => { findButton(tree, 'Save without video').props.onPress(); });

    const [, deps] = mockSaveGame.mock.calls[0];
    expect(deps.teamScore).toBe(82);
    expect(deps.opponentScore).toBe(75);
    expect(deps.stats).toEqual({ 1: STAT_LINE_1, 2: STAT_LINE_2 });
    expect(deps.events).toEqual(EVENTS);
  });

  test('clears the AsyncStorage marker on success', async () => {
    seed();
    wireSuccessfulSave();

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<PendingUploadBanner onDismiss={jest.fn()} />);
    });

    await act(async () => { findButton(tree, 'Save without video').props.onPress(); });

    expect(AsyncStorage.removeItem).toHaveBeenCalledWith(PENDING_UPLOAD_KEY);
    expect(mockAsyncStore[PENDING_UPLOAD_KEY]).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Upload failure test
// ═════════════════════════════════════════════════════════════════════════════

describe('PendingUploadBanner — upload failure', () => {
  test('shows Alert.alert with an error message when uploadVideoFile rejects', async () => {
    seed();
    mockUploadVideo.mockRejectedValueOnce(new Error('network error'));

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<PendingUploadBanner onDismiss={jest.fn()} />);
    });

    await act(async () => { findButton(tree, 'Resume upload').props.onPress(); });

    expect(alertSpy).toHaveBeenCalledTimes(1);
    const [title, message] = alertSpy.mock.calls[0];
    expect(title).toBe('Upload failed');
    expect(message).toContain('network error');
  });

  test('does NOT remove the AsyncStorage marker when upload fails', async () => {
    seed();
    mockUploadVideo.mockRejectedValueOnce(new Error('network error'));

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<PendingUploadBanner onDismiss={jest.fn()} />);
    });

    await act(async () => { findButton(tree, 'Resume upload').props.onPress(); });

    expect(AsyncStorage.removeItem).not.toHaveBeenCalledWith(PENDING_UPLOAD_KEY);
    expect(mockAsyncStore[PENDING_UPLOAD_KEY]).toBeDefined();
  });

  test('does NOT call saveGame when upload fails', async () => {
    seed();
    mockUploadVideo.mockRejectedValueOnce(new Error('network error'));

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<PendingUploadBanner onDismiss={jest.fn()} />);
    });

    await act(async () => { findButton(tree, 'Resume upload').props.onPress(); });

    expect(mockSaveGame).not.toHaveBeenCalled();
  });
});
