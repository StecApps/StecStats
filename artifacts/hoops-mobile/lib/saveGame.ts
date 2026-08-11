import { Alert } from 'react-native';
import * as Haptics from 'expo-haptics';

export interface StatLine {
  ftMade: number; ftAttempted: number;
  twoMade: number; twoAttempted: number;
  threeMade: number; threeAttempted: number;
  assists: number; rebounds: number;
  steals: number; turnovers: number; blocks: number;
}

export interface GameEvent {
  playerId: number; statField: string; delta: number; videoTimestampMs: number;
}

export interface SaveGameDeps {
  /** Players on the active roster — used to build the stat-lines array. */
  players: Array<{ id: number }>;
  /** Per-player stat accumulation map keyed by player id. */
  stats: Record<number, StatLine>;
  teamScore: number;
  opponentScore: number;
  teamId: number | string;
  opponent: string;
  date: string;
  events: GameEvent[];
  /** Bound mutateAsync from useCreateGame(). */
  createGameMutateAsync: (args: { data: object }) => Promise<{ id: number }>;
  /** Bound invalidateQueries from useQueryClient(). */
  invalidateQueries: (opts: { queryKey: string[] }) => Promise<void>;
  /** router.replace from expo-router. */
  routerReplace: (path: string) => void;
  /** Component setSaving state setter. */
  setSaving: (v: boolean) => void;
  /**
   * Stable client-generated UUID for this save attempt.  Sent to the server so
   * it can store the ID with the created game.  If a network drop means the
   * server wrote the row but the response was lost, the same ID is passed to
   * onNetworkFailure so the retry can dedup rather than create a duplicate.
   * Generate once (before calling saveGame) and share with onNetworkFailure.
   */
  clientId: string;
  /**
   * Called instead of the generic 'Save failed' alert when a network-level
   * error (TypeError / "Network request failed") prevents the POST from
   * reaching the server.  Use this to queue the game locally for offline sync.
   * If omitted the generic alert is shown as before.
   */
  onNetworkFailure?: () => Promise<void> | void;
}

const defaultLine = (): StatLine => ({
  ftMade: 0, ftAttempted: 0,
  twoMade: 0, twoAttempted: 0,
  threeMade: 0, threeAttempted: 0,
  assists: 0, rebounds: 0,
  steals: 0, turnovers: 0, blocks: 0,
});

/**
 * Saves a completed game via the API and navigates to the game detail screen.
 *
 * Handles both the video and no-video paths — pass null for videoObjectPath
 * when saving without a recording.
 *
 * On success: fires the success haptic, invalidates the team-games query cache,
 * and navigates to /game/:id.
 *
 * On failure: shows Alert('Save failed') and resets the saving flag so the
 * coach can try again.
 */
export async function saveGame(
  videoObjectPath: string | null,
  deps: SaveGameDeps,
): Promise<void> {
  const {
    players,
    stats,
    teamScore,
    opponentScore,
    teamId,
    opponent,
    date,
    events,
    clientId,
    createGameMutateAsync,
    invalidateQueries,
    routerReplace,
    setSaving,
  } = deps;

  try {
    const statLines = players.map((p) => {
      const line = stats[p.id] ?? defaultLine();
      return { playerId: p.id, ...line };
    });
    const result = teamScore > opponentScore ? 'W' : 'L';
    const game = await createGameMutateAsync({
      data: {
        // clientId is sent as an extra field (not in the Zod schema) and read
        // by the server before Zod parsing for durable idempotency.  If the
        // network drops after the server writes the row but before the response
        // arrives, the onNetworkFailure queue uses this same ID so the replay
        // hits the ON CONFLICT DO NOTHING path instead of inserting a duplicate.
        clientId,
        teamId: Number(teamId),
        opponent,
        date,
        result,
        teamScore,
        opponentScore,
        stats: statLines,
        events,
        ...(videoObjectPath ? { videoObjectPath } : {}),
      },
    });
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    await invalidateQueries({ queryKey: ['listTeamGames'] });
    routerReplace(`/game/${game.id}`);
  } catch (err: any) {
    // Network-level failures (no connection, ECONNREFUSED, timeout) produce a
    // TypeError with 'Network request failed' rather than an HTTP status error.
    // Give the caller a chance to queue the game locally instead of losing it.
    const isNetworkError =
      err instanceof TypeError ||
      (typeof err?.message === 'string' &&
        (err.message.includes('Network request failed') ||
          err.message.includes('Failed to fetch') ||
          err.message.includes('network')));
    if (isNetworkError && deps.onNetworkFailure) {
      setSaving(false);
      await deps.onNetworkFailure();
      return;
    }
    Alert.alert('Save failed', err?.message ?? 'Could not save game');
    setSaving(false);
  }
}
