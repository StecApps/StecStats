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
    Alert.alert('Save failed', err?.message ?? 'Could not save game');
    setSaving(false);
  }
}
