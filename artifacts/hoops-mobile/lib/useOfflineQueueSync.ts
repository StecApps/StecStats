/**
 * App-level hook that survives navigation (scorekeeper → games tab).
 *
 * Responsibilities:
 *  - Polls connectivity every 10 s.
 *  - Flushes the offline game queue when the device comes back online.
 *  - Also flushes on every app-foreground event (AppState 'active').
 *
 * This must run inside a component that is ALWAYS mounted (e.g. ApiAuthSetup
 * in _layout.tsx), NOT inside the scorekeeper screen, which unmounts
 * immediately after router.replace() on an offline save.
 *
 * The core sync logic lives in the exported `syncQueuedGames()` function so
 * it can be unit-tested directly without mounting the hook.
 */

import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useAuth } from '@clerk/clerk-expo';
import { useQueryClient } from '@tanstack/react-query';
import {
  loadQueuedGames,
  removeQueuedGame,
  checkConnectivity,
  type QueuedGame,
} from './offlineQueue';
import {
  getListTeamGamesQueryKey,
  getListAllGamesQueryKey,
} from '@workspace/api-client-react';

// ── Exported for testing ──────────────────────────────────────────────────────

export interface SyncQueuedGamesDeps {
  apiBase: string;
  isSignedIn: boolean;
  getToken: () => Promise<string | null>;
}

/**
 * Flush any games in the offline queue to the server.
 *
 * Each game is posted with its `clientId` so the server can deduplicate retries
 * via ON CONFLICT DO NOTHING.  On a successful 201 the entry is removed from
 * the queue; on a 4xx it is discarded (team deleted, etc.); on a 5xx or network
 * error it remains for the next sync cycle.
 *
 * Returns the count of successfully synced games and the game objects themselves
 * so the caller can invalidate per-team query caches without needing to re-read
 * the queue.
 *
 * This function is exported so tests can exercise it directly without mounting
 * the hook or mocking React / connectivity internals.
 */
export async function syncQueuedGames(
  deps: SyncQueuedGamesDeps,
): Promise<{ synced: number; syncedGames: QueuedGame[] }> {
  const { apiBase, isSignedIn, getToken } = deps;

  if (!isSignedIn) return { synced: 0, syncedGames: [] };

  let queued: QueuedGame[];
  try {
    queued = await loadQueuedGames();
  } catch (err) {
    // Queue read failed (I/O error or corrupted JSON) — log and skip this
    // sync cycle rather than masking the error or crashing the app.
    console.warn('[OfflineSync] Could not read offline queue:', (err as Error).message);
    return { synced: 0, syncedGames: [] };
  }
  if (queued.length === 0) return { synced: 0, syncedGames: [] };

  const token = await getToken().catch(() => null);
  if (!token) return { synced: 0, syncedGames: [] };

  let synced = 0;
  const syncedGames: QueuedGame[] = [];
  for (const game of queued) {
    try {
      const res = await fetch(`${apiBase}/api/games`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(game), // includes clientId for server-side dedup
      });
      if (res.ok) {
        await removeQueuedGame(game.clientId);
        synced++;
        syncedGames.push(game);
      } else if (res.status >= 400 && res.status < 500) {
        // Client error (e.g. team deleted) — discard to avoid blocking
        // future games.  Log it so it can be investigated.
        console.warn(
          `[OfflineSync] Discarding queued game ${game.clientId}: HTTP ${res.status}`,
        );
        await removeQueuedGame(game.clientId);
      }
      // 5xx: leave in queue and retry next time
    } catch {
      break; // network still down — stop and retry later
    }
  }

  return { synced, syncedGames };
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useOfflineQueueSync(apiBase: string) {
  const { getToken, isSignedIn } = useAuth();
  const qc = useQueryClient();
  const syncInFlightRef = useRef(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevOnlineRef = useRef(true);

  async function syncQueued() {
    // Guard against concurrent syncs — only one flush at a time.
    if (syncInFlightRef.current) return;
    syncInFlightRef.current = true;
    try {
      const { synced, syncedGames } = await syncQueuedGames({
        apiBase,
        isSignedIn: !!isSignedIn,
        getToken,
      });
      if (synced > 0) {
        // Invalidate the all-games list (default "All Teams" view)
        qc.invalidateQueries({ queryKey: getListAllGamesQueryKey() });
        // Invalidate per-team lists for every team that had a game synced
        const syncedTeamIds = new Set(syncedGames.map((g) => g.teamId));
        for (const teamId of syncedTeamIds) {
          qc.invalidateQueries({ queryKey: getListTeamGamesQueryKey(teamId) });
        }
      }
    } finally {
      syncInFlightRef.current = false;
    }
  }

  useEffect(() => {
    if (!isSignedIn) return;

    async function probe() {
      const online = await checkConnectivity(apiBase);
      const wasOnline = prevOnlineRef.current;
      prevOnlineRef.current = online;
      if (online && !wasOnline) {
        // Connectivity just recovered — flush the queue immediately
        syncQueued();
      } else if (online && wasOnline) {
        // Already online on this probe (including initial boot) — flush too.
        // This covers the case where the app restarts while online: prevOnlineRef
        // starts true and there is no offline→online transition, but queued games
        // from a previous session still need to be sent.
        syncQueued();
      }
    }

    // Immediate first probe + periodic interval
    probe();
    intervalRef.current = setInterval(probe, 10_000);

    // Also flush on every foreground event (app reopened from background)
    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') syncQueued();
    });

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      sub.remove();
    };
  }, [isSignedIn, apiBase]); // eslint-disable-line react-hooks/exhaustive-deps
}
