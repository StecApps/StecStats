/**
 * Unit tests for the scorekeeper draft-recovery flow.
 *
 * The scorekeeper calls `resolveDraft(teamId, opponent, date)` on mount —
 * exported from lib/offlineQueue.ts and used as the single source of truth for
 * draft-recovery eligibility.  These tests exercise that production helper
 * directly, plus the Alert-wiring and state-restore contract via a minimal
 * DraftRecoveryHarness that calls the real resolveDraft (no duplication of
 * the matching predicate).
 *
 * Covered scenarios
 * -----------------
 *   1. resolveDraft returns a matching draft and Alert is shown.
 *   2. Alert title and message are correct.
 *   3. Alert has both "Restore" and "Discard" buttons.
 *   4. Restore delivers stats, events, opponentScore, teamScoreAdj, half,
 *      seconds from the draft.
 *   5. Restore does NOT clear AsyncStorage (autosave keeps updating the draft).
 *   6. Discard removes the draft from AsyncStorage.
 *   7. Discard does NOT invoke the onRestore callback.
 *   8. Stale draft (wrong teamId) → resolveDraft returns null, no Alert, entry
 *      is deleted from AsyncStorage.
 *   9. Stale draft (wrong opponent) → same.
 *  10. Stale draft (wrong date) → same.
 *  11. No Alert when AsyncStorage is empty.
 *  12–16. saveDraft / loadDraft / clearDraft / resolveDraft round-trip coverage.
 *  17–21. Autosave timer — debounce cadence and stale-closure safety.
 */

// ── Mocks (hoisted before imports) ────────────────────────────────────────────

// In-memory AsyncStorage — variable must start with "mock" for Jest hoisting.
let mockAsyncStore: Record<string, string> = {};
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem:    jest.fn(async (k: string) => mockAsyncStore[k] ?? null),
    setItem:    jest.fn(async (k: string, v: string) => { mockAsyncStore[k] = v; }),
    removeItem: jest.fn(async (k: string) => { delete mockAsyncStore[k]; }),
  },
}));

// Minimal react-native mock — only what the harness and offlineQueue need.
jest.mock('react-native', () => {
  const React = require('react');
  const el = (name: string) =>
    function MockEl({ children, ...rest }: any) {
      return React.createElement(name, rest, children);
    };
  return {
    View:       el('View'),
    Text:       el('Text'),
    Alert:      { alert: jest.fn() },
    Platform:   { OS: 'ios', select: (o: any) => o.ios ?? o.default },
    StyleSheet: { create: (s: any) => s, flatten: (s: any) => s },
  };
});

// ── Imports ───────────────────────────────────────────────────────────────────

import React, { useEffect } from 'react';
import renderer, { act } from 'react-test-renderer';
import { Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  SCOREKEEPER_DRAFT_KEY,
  saveDraft,
  loadDraft,
  clearDraft,
  resolveDraft,
  type ScorekeeperDraft,
} from '../lib/offlineQueue';

import { useAutosaveDraft } from '../lib/useAutosaveDraft';

import type { StatLine, GameEvent } from '../lib/saveGame';

const alertSpy = Alert.alert as jest.Mock;

// ── DraftRecoveryHarness ──────────────────────────────────────────────────────
//
// Minimal component that reproduces the scorekeeper's draft-recovery useEffect
// using the REAL resolveDraft() helper from production code.  Alert wiring and
// the Restore/Discard callbacks are the same shape as scorekeeper.tsx.

interface HarnessProps {
  teamId?: number;
  opponent?: string;
  date?: string;
  onRestore?: (draft: ScorekeeperDraft) => void;
}

function DraftRecoveryHarness({
  teamId   = 42,
  opponent = 'Rivals',
  date     = '2026-05-10',
  onRestore = () => {},
}: HarnessProps) {
  useEffect(() => {
    (async () => {
      // Real production helper — same call as scorekeeper.tsx line 143-148
      const draft = await resolveDraft(teamId, opponent, date);
      if (!draft) return;

      Alert.alert(
        'Resume Game?',
        'It looks like this game was interrupted. Restore your stats from the last autosave?',
        [
          {
            text:    'Discard',
            style:   'destructive',
            onPress: () => clearDraft(),
          },
          {
            text:    'Restore',
            style:   'default',
            onPress: () => onRestore(draft),
          },
        ],
      );
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PLAYER_STATS: Record<number, StatLine> = {
  7: {
    ftMade: 3, ftAttempted: 4,
    twoMade: 5, twoAttempted: 9,
    threeMade: 2, threeAttempted: 5,
    assists: 4, rebounds: 7,
    steals: 2, turnovers: 1, blocks: 1,
  },
};

const EVENTS: GameEvent[] = [
  { playerId: 7, statField: 'twoMade', delta: 1, videoTimestampMs: 5000 },
];

function makeDraft(overrides: Partial<ScorekeeperDraft> = {}): ScorekeeperDraft {
  return {
    teamId:        42,
    teamName:      'My Team',
    opponent:      'Rivals',
    date:          '2026-05-10',
    stats:         PLAYER_STATS,
    events:        EVENTS,
    opponentScore: 18,
    teamScoreAdj:  2,
    half:          2,
    seconds:       420,
    savedAt:       new Date().toISOString(),
    ...overrides,
  };
}

function seedDraft(draft: ScorekeeperDraft = makeDraft()) {
  mockAsyncStore[SCOREKEEPER_DRAFT_KEY] = JSON.stringify(draft);
}

/** Pull the onPress handler for a named Alert button. */
function getAlertButton(label: string): () => void {
  expect(alertSpy).toHaveBeenCalled();
  const buttons: Array<{ text: string; onPress?: () => void }> =
    alertSpy.mock.calls[alertSpy.mock.calls.length - 1][2];
  const btn = buttons.find((b) => b.text === label);
  if (!btn) throw new Error(`Alert button "${label}" not found`);
  return btn.onPress!;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockAsyncStore = {};
});

// ═════════════════════════════════════════════════════════════════════════════
// resolveDraft — production helper under test
// ═════════════════════════════════════════════════════════════════════════════

describe('resolveDraft — production match / clear logic', () => {
  test('returns matching draft when teamId, opponent, and date all match', async () => {
    seedDraft();
    const result = await resolveDraft(42, 'Rivals', '2026-05-10');
    expect(result).not.toBeNull();
    expect(result?.teamId).toBe(42);
  });

  test('returns null and clears storage when teamId does not match', async () => {
    seedDraft(makeDraft({ teamId: 999 }));
    const result = await resolveDraft(42, 'Rivals', '2026-05-10');
    expect(result).toBeNull();
    expect(mockAsyncStore[SCOREKEEPER_DRAFT_KEY]).toBeUndefined();
  });

  test('returns null and clears storage when opponent does not match', async () => {
    seedDraft(makeDraft({ opponent: 'Wrong Team' }));
    const result = await resolveDraft(42, 'Rivals', '2026-05-10');
    expect(result).toBeNull();
    expect(mockAsyncStore[SCOREKEEPER_DRAFT_KEY]).toBeUndefined();
  });

  test('returns null and clears storage when date does not match', async () => {
    seedDraft(makeDraft({ date: '2020-01-01' }));
    const result = await resolveDraft(42, 'Rivals', '2026-05-10');
    expect(result).toBeNull();
    expect(mockAsyncStore[SCOREKEEPER_DRAFT_KEY]).toBeUndefined();
  });

  test('returns null without touching storage when storage is empty', async () => {
    const result = await resolveDraft(42, 'Rivals', '2026-05-10');
    expect(result).toBeNull();
    expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
  });

  test('returned draft contains all autosaved fields', async () => {
    seedDraft();
    const result = await resolveDraft(42, 'Rivals', '2026-05-10');
    expect(result?.stats).toEqual(PLAYER_STATS);
    expect(result?.events).toEqual(EVENTS);
    expect(result?.opponentScore).toBe(18);
    expect(result?.teamScoreAdj).toBe(2);
    expect(result?.half).toBe(2);
    expect(result?.seconds).toBe(420);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Alert shown for matching draft (via harness using real resolveDraft)
// ═════════════════════════════════════════════════════════════════════════════

describe('Draft recovery — Alert shown for matching draft', () => {
  test('shows "Resume Game?" Alert when a matching draft exists', async () => {
    seedDraft();
    await act(async () => { renderer.create(<DraftRecoveryHarness />); });
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy.mock.calls[0][0]).toBe('Resume Game?');
  });

  test('Alert message mentions the game being interrupted', async () => {
    seedDraft();
    await act(async () => { renderer.create(<DraftRecoveryHarness />); });
    expect(alertSpy.mock.calls[0][1]).toMatch(/interrupted/i);
  });

  test('Alert has both "Restore" and "Discard" buttons', async () => {
    seedDraft();
    await act(async () => { renderer.create(<DraftRecoveryHarness />); });
    const labels = (alertSpy.mock.calls[0][2] as Array<{ text: string }>).map(
      (b) => b.text,
    );
    expect(labels).toContain('Restore');
    expect(labels).toContain('Discard');
  });

  test('no Alert when no draft is in AsyncStorage', async () => {
    await act(async () => { renderer.create(<DraftRecoveryHarness />); });
    expect(alertSpy).not.toHaveBeenCalled();
  });

  test('no Alert when the stored draft is for a different game', async () => {
    seedDraft(makeDraft({ teamId: 999 }));
    await act(async () => { renderer.create(<DraftRecoveryHarness teamId={42} />); });
    expect(alertSpy).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// "Restore" delivers the full state contract
// ═════════════════════════════════════════════════════════════════════════════

describe('Draft recovery — "Restore" re-hydrates all game-state fields', () => {
  async function mountAndRestore(draft = makeDraft()) {
    seedDraft(draft);
    const onRestore = jest.fn();
    await act(async () => {
      renderer.create(<DraftRecoveryHarness onRestore={onRestore} />);
    });
    await act(async () => { getAlertButton('Restore')(); });
    return onRestore;
  }

  test('Restore delivers opponentScore', async () => {
    const onRestore = await mountAndRestore(makeDraft({ opponentScore: 18 }));
    expect(onRestore.mock.calls[0][0].opponentScore).toBe(18);
  });

  test('Restore delivers teamScoreAdj', async () => {
    const onRestore = await mountAndRestore(makeDraft({ teamScoreAdj: 2 }));
    expect(onRestore.mock.calls[0][0].teamScoreAdj).toBe(2);
  });

  test('Restore delivers half', async () => {
    const onRestore = await mountAndRestore(makeDraft({ half: 2 }));
    expect(onRestore.mock.calls[0][0].half).toBe(2);
  });

  test('Restore delivers seconds', async () => {
    const onRestore = await mountAndRestore(makeDraft({ seconds: 420 }));
    expect(onRestore.mock.calls[0][0].seconds).toBe(420);
  });

  test('Restore delivers stats and events', async () => {
    const onRestore = await mountAndRestore();
    const restored: ScorekeeperDraft = onRestore.mock.calls[0][0];
    expect(restored.stats).toEqual(PLAYER_STATS);
    expect(restored.events).toEqual(EVENTS);
  });

  test('AsyncStorage draft is NOT cleared when Restore is chosen', async () => {
    await mountAndRestore();
    expect(AsyncStorage.removeItem).not.toHaveBeenCalledWith(SCOREKEEPER_DRAFT_KEY);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// "Discard" clears the draft
// ═════════════════════════════════════════════════════════════════════════════

describe('Draft recovery — "Discard" clears the draft', () => {
  test('AsyncStorage entry is removed when Discard is chosen', async () => {
    seedDraft();
    await act(async () => { renderer.create(<DraftRecoveryHarness />); });
    await act(async () => { getAlertButton('Discard')(); });
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith(SCOREKEEPER_DRAFT_KEY);
    expect(mockAsyncStore[SCOREKEEPER_DRAFT_KEY]).toBeUndefined();
  });

  test('Discard does NOT invoke the onRestore callback', async () => {
    seedDraft();
    const onRestore = jest.fn();
    await act(async () => {
      renderer.create(<DraftRecoveryHarness onRestore={onRestore} />);
    });
    await act(async () => { getAlertButton('Discard')(); });
    expect(onRestore).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// saveDraft / loadDraft / clearDraft round-trips
// ═════════════════════════════════════════════════════════════════════════════

describe('offlineQueue — saveDraft / loadDraft / clearDraft', () => {
  test('saveDraft persists the draft and loadDraft retrieves it', async () => {
    const draft = makeDraft();
    await saveDraft(draft);
    expect(await loadDraft()).toEqual(draft);
  });

  test('loadDraft returns null when nothing has been saved', async () => {
    expect(await loadDraft()).toBeNull();
  });

  test('clearDraft removes the entry so loadDraft returns null afterwards', async () => {
    await saveDraft(makeDraft());
    await clearDraft();
    expect(await loadDraft()).toBeNull();
  });

  test('saveDraft overwrites a previous draft with updated fields', async () => {
    await saveDraft(makeDraft({ opponentScore: 5 }));
    await saveDraft(makeDraft({ opponentScore: 12 }));
    expect((await loadDraft())?.opponentScore).toBe(12);
  });

  test('SCOREKEEPER_DRAFT_KEY is the storage key used by save/load/clear', async () => {
    await saveDraft(makeDraft());
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      SCOREKEEPER_DRAFT_KEY, expect.any(String),
    );
    await clearDraft();
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith(SCOREKEEPER_DRAFT_KEY);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Autosave timer — debounce cadence and stale-closure safety
//
// These tests exercise the REAL useAutosaveDraft hook (lib/useAutosaveDraft.ts)
// which is the same code scorekeeper.tsx calls in production.  A stale
// closure, a changed debounce duration, a removed cleanup, or a missing
// dependency in the production hook will cause these tests to fail.
//
// Covered scenarios
// -----------------
//  17. saveDraft is called once per independent state change after the 2 s
//      debounce window — 3 changes × 2 s each = 3 saves in 6 s.
//  18. Rapid successive changes within a single 2 s window collapse into
//      exactly one save (debounce, not interval).
//  19. Each saved draft captures the score value current at fire time, not
//      the value that was in scope when the effect first ran (stale-closure
//      check).
//  20. Changing score mid-debounce resets the timer — the final save
//      reflects the newest value, and only one save is emitted.
//  21. The timer does not fire again after the component unmounts (no
//      leaked timers).
// ═════════════════════════════════════════════════════════════════════════════

// ── AutosaveTimerHarness ─────────────────────────────────────────────────────
//
// Thin wrapper that calls the REAL useAutosaveDraft hook from production code.
// Only `opponentScore` and `saving` vary between test cases; all other fields
// stay at fixed defaults so the tests stay focused on timer behavior.

interface AutosaveHarnessProps {
  opponentScore: number;
  saving?: boolean;
}

function AutosaveTimerHarness({ opponentScore, saving = false }: AutosaveHarnessProps) {
  useAutosaveDraft({
    teamId:       1,
    teamName:     'Test Team',
    opponent:     'Rivals',
    date:         '2026-01-01',
    stats:        {},
    events:       [],
    opponentScore,
    teamScoreAdj: 0,
    half:         1,
    seconds:      0,
    saving,
  });
  return null;
}

// ── Timer test suite ──────────────────────────────────────────────────────────

describe('Autosave timer — debounce cadence and stale-closure safety', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAsyncStore = {};
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  // ── Test 17 ──────────────────────────────────────────────────────────────
  test(
    'saveDraft fires at least 3 times when state changes 3 times with 2 s gaps (6 s total)',
    async () => {
      let tree: renderer.ReactTestRenderer;

      // Render with initial score — this arms the first 2 s debounce.
      await act(async () => {
        tree = renderer.create(<AutosaveTimerHarness opponentScore={0} />);
      });

      // Advance 2 s → first debounce fires → save #1 (score = 0).
      act(() => { jest.advanceTimersByTime(2_000); });
      await act(async () => {});

      // Change score to 10 → resets debounce.
      await act(async () => { tree!.update(<AutosaveTimerHarness opponentScore={10} />); });

      // Advance 2 s → second debounce fires → save #2 (score = 10).
      act(() => { jest.advanceTimersByTime(2_000); });
      await act(async () => {});

      // Change score to 20 → resets debounce.
      await act(async () => { tree!.update(<AutosaveTimerHarness opponentScore={20} />); });

      // Advance 2 s → third debounce fires → save #3 (score = 20).
      act(() => { jest.advanceTimersByTime(2_000); });
      await act(async () => {});

      // AsyncStorage.setItem is called once per debounce fire.
      expect(AsyncStorage.setItem).toHaveBeenCalledTimes(3);
      // Every call targeted the draft key.
      (AsyncStorage.setItem as jest.Mock).mock.calls.forEach(([key]) => {
        expect(key).toBe(SCOREKEEPER_DRAFT_KEY);
      });
    },
  );

  // ── Test 18 ──────────────────────────────────────────────────────────────
  test(
    'rapid successive changes within 2 s collapse into exactly one save (debounce, not interval)',
    async () => {
      let tree: renderer.ReactTestRenderer;

      await act(async () => {
        tree = renderer.create(<AutosaveTimerHarness opponentScore={0} />);
      });

      // Three rapid score changes — each resets the 2 s timer.
      await act(async () => { tree!.update(<AutosaveTimerHarness opponentScore={5} />); });
      act(() => { jest.advanceTimersByTime(500); }); // only 0.5 s — timer not yet done
      await act(async () => { tree!.update(<AutosaveTimerHarness opponentScore={10} />); });
      act(() => { jest.advanceTimersByTime(500); });
      await act(async () => { tree!.update(<AutosaveTimerHarness opponentScore={15} />); });

      // After all the resets only 1 s has elapsed since the last change.
      // Advance the remaining 2 s to fire the single debounced save.
      act(() => { jest.advanceTimersByTime(2_000); });
      await act(async () => {});

      // Only ONE save despite three score changes.
      expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1);
    },
  );

  // ── Test 19 ──────────────────────────────────────────────────────────────
  test(
    'each saved draft reflects the score value current at fire time — not a stale closure snapshot',
    async () => {
      let tree: renderer.ReactTestRenderer;

      await act(async () => {
        tree = renderer.create(<AutosaveTimerHarness opponentScore={7} />);
      });

      // Fire first save (score = 7).
      act(() => { jest.advanceTimersByTime(2_000); });
      await act(async () => {});

      const firstSave = JSON.parse(
        (AsyncStorage.setItem as jest.Mock).mock.calls[0][1],
      ) as { opponentScore: number };
      expect(firstSave.opponentScore).toBe(7);

      // Change score — the new effect closure captures 22.
      await act(async () => { tree!.update(<AutosaveTimerHarness opponentScore={22} />); });

      // Fire second save (score should be 22, not the stale 7).
      act(() => { jest.advanceTimersByTime(2_000); });
      await act(async () => {});

      const secondSave = JSON.parse(
        (AsyncStorage.setItem as jest.Mock).mock.calls[1][1],
      ) as { opponentScore: number };
      expect(secondSave.opponentScore).toBe(22);
    },
  );

  // ── Test 20 ──────────────────────────────────────────────────────────────
  test(
    'changing score mid-debounce resets the timer — final save reflects the newest value',
    async () => {
      let tree: renderer.ReactTestRenderer;

      await act(async () => {
        tree = renderer.create(<AutosaveTimerHarness opponentScore={3} />);
      });

      // Advance only 1 s — timer not yet done.
      act(() => { jest.advanceTimersByTime(1_000); });

      // Score changes at t=1 s → timer resets; previous timer is cancelled.
      await act(async () => { tree!.update(<AutosaveTimerHarness opponentScore={99} />); });

      // Advance 2 s from the reset — the save fires with score = 99.
      act(() => { jest.advanceTimersByTime(2_000); });
      await act(async () => {});

      expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1);
      const saved = JSON.parse(
        (AsyncStorage.setItem as jest.Mock).mock.calls[0][1],
      ) as { opponentScore: number };
      expect(saved.opponentScore).toBe(99);
    },
  );

  // ── Test 21 ──────────────────────────────────────────────────────────────
  test(
    'the autosave timer does not fire after the component unmounts — no leaked timers',
    async () => {
      let tree: renderer.ReactTestRenderer;

      await act(async () => {
        tree = renderer.create(<AutosaveTimerHarness opponentScore={5} />);
      });

      // Unmount before the 2 s debounce fires.
      await act(async () => { tree!.unmount(); });

      // Advance past the debounce window — the cleanup should have cleared the timer.
      act(() => { jest.advanceTimersByTime(3_000); });
      await act(async () => {});

      // No save should have been written after unmount.
      expect(AsyncStorage.setItem).not.toHaveBeenCalled();
    },
  );
});
