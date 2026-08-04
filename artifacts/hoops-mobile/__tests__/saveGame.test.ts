/**
 * Tests for saveGame() in lib/saveGame.ts — the function called by scorekeeper
 * when a coach saves a completed game (with or without a video recording).
 *
 * Covers the two scenarios required by the no-video guard story:
 *
 *   1. saveGame(null) — "Save without video" path — calls createGame with no
 *      videoObjectPath and navigates to /game/:id on success.
 *
 *   2. saveGame(null) when createGame rejects — shows Alert('Save failed', ...)
 *      and does NOT navigate.
 *
 * Tests import the real production function from lib/saveGame so any change to
 * the Alert title, navigation path, or error handling in that file breaks these
 * tests immediately.
 */

jest.mock('react-native', () => ({
  Alert: { alert: jest.fn() },
  Platform: { OS: 'ios' },
}));

// Haptics.notificationAsync is called on success — stub it out.
jest.mock('expo-haptics', () => ({
  notificationAsync: jest.fn().mockResolvedValue(undefined),
  NotificationFeedbackType: { Success: 'success' },
}));

import { Alert } from 'react-native';
import * as Haptics from 'expo-haptics';
import { saveGame, type SaveGameDeps, type StatLine } from '../lib/saveGame';

const alertSpy = Alert.alert as jest.Mock;
const hapticsSpy = Haptics.notificationAsync as jest.Mock;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const PLAYER_1 = { id: 1 };
const PLAYER_2 = { id: 2 };

const STAT_LINE: StatLine = {
  ftMade: 2, ftAttempted: 3,
  twoMade: 4, twoAttempted: 5,
  threeMade: 1, threeAttempted: 2,
  assists: 3, rebounds: 5,
  steals: 1, turnovers: 0, blocks: 2,
};

function makeDeps(overrides: Partial<SaveGameDeps> = {}): SaveGameDeps {
  return {
    players: [PLAYER_1, PLAYER_2],
    stats: { [PLAYER_1.id]: STAT_LINE },
    teamScore: 15,
    opponentScore: 10,
    teamId: 7,
    opponent: 'Lakers',
    date: '2026-08-04',
    events: [],
    createGameMutateAsync: jest.fn().mockResolvedValue({ id: 42 }),
    invalidateQueries: jest.fn().mockResolvedValue(undefined),
    routerReplace: jest.fn(),
    setSaving: jest.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── Success path ─────────────────────────────────────────────────────────────

describe('saveGame(null) — success path', () => {
  test('calls createGame.mutateAsync without videoObjectPath when passed null', async () => {
    const deps = makeDeps();
    await saveGame(null, deps);

    expect(deps.createGameMutateAsync).toHaveBeenCalledTimes(1);
    const [call] = (deps.createGameMutateAsync as jest.Mock).mock.calls;
    expect(call[0].data).not.toHaveProperty('videoObjectPath');
  });

  test('navigates to /game/:id on success', async () => {
    const deps = makeDeps();
    await saveGame(null, deps);

    expect(deps.routerReplace).toHaveBeenCalledWith('/game/42');
    expect(deps.routerReplace).toHaveBeenCalledTimes(1);
  });

  test('does not show an alert on success', async () => {
    const deps = makeDeps();
    await saveGame(null, deps);

    expect(alertSpy).not.toHaveBeenCalled();
  });

  test('fires the success haptic on success', async () => {
    const deps = makeDeps();
    await saveGame(null, deps);

    expect(hapticsSpy).toHaveBeenCalledTimes(1);
  });

  test('includes correct game metadata in the createGame payload', async () => {
    const deps = makeDeps();
    await saveGame(null, deps);

    const [call] = (deps.createGameMutateAsync as jest.Mock).mock.calls;
    const { data } = call[0];
    expect(data).toMatchObject({
      teamId: 7,
      opponent: 'Lakers',
      date: '2026-08-04',
      result: 'W',        // 15 > 10
      teamScore: 15,
      opponentScore: 10,
    });
  });

  test('sets result to "L" when team score is lower', async () => {
    const deps = makeDeps({ teamScore: 8, opponentScore: 20 });
    await saveGame(null, deps);

    const [call] = (deps.createGameMutateAsync as jest.Mock).mock.calls;
    expect(call[0].data.result).toBe('L');
  });

  test('passes videoObjectPath when one is provided', async () => {
    const deps = makeDeps();
    await saveGame('videos/game-123.mp4', deps);

    const [call] = (deps.createGameMutateAsync as jest.Mock).mock.calls;
    expect(call[0].data.videoObjectPath).toBe('videos/game-123.mp4');
  });

  test('invalidates listTeamGames query on success', async () => {
    const deps = makeDeps();
    await saveGame(null, deps);

    expect(deps.invalidateQueries).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['listTeamGames'] }),
    );
  });
});

// ─── Failure path ─────────────────────────────────────────────────────────────

describe('saveGame(null) — createGame rejects (upload API down)', () => {
  test('shows Alert("Save failed") when createGame rejects', async () => {
    const deps = makeDeps({
      createGameMutateAsync: jest.fn().mockRejectedValue(
        new Error('Network error — could not reach server'),
      ),
    });
    await saveGame(null, deps);

    expect(alertSpy).toHaveBeenCalledWith(
      'Save failed',
      'Network error — could not reach server',
    );
  });

  test('shows Alert("Save failed") with fallback message when rejection has no message', async () => {
    const deps = makeDeps({
      createGameMutateAsync: jest.fn().mockRejectedValue({}),
    });
    await saveGame(null, deps);

    expect(alertSpy).toHaveBeenCalledWith('Save failed', 'Could not save game');
  });

  test('calls setSaving(false) when createGame rejects', async () => {
    const deps = makeDeps({
      createGameMutateAsync: jest.fn().mockRejectedValue(
        new Error('500 Internal Server Error'),
      ),
    });
    await saveGame(null, deps);

    expect(deps.setSaving).toHaveBeenCalledWith(false);
  });

  test('does NOT navigate when createGame rejects', async () => {
    const deps = makeDeps({
      createGameMutateAsync: jest.fn().mockRejectedValue(
        new Error('500 Internal Server Error'),
      ),
    });
    await saveGame(null, deps);

    expect(deps.routerReplace).not.toHaveBeenCalled();
  });

  test('does NOT fire the success haptic when createGame rejects', async () => {
    const deps = makeDeps({
      createGameMutateAsync: jest.fn().mockRejectedValue(
        new Error('500 Internal Server Error'),
      ),
    });
    await saveGame(null, deps);

    expect(hapticsSpy).not.toHaveBeenCalled();
  });
});
