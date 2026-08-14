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
 */

import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useAuth } from '@clerk/clerk-expo';
import { useQueryClient } from '@tanstack/react-query';
import {
  loadQueuedGames,
  removeQueuedGame,
  checkConnectivity,
} from './offlineQueue';
import {
  getListTeamGamesQueryKey,
  getListAllGamesQueryKey,
} from '@workspace/api-client-react';

export function useOfflineQueueSync(apiBase: string) {
  const { getToken, isSignedIn } = useAuth();
  const qc = useQueryClient();
  const syncInFlightRef = useRef(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevOnlineRef = useRef(true);

  async function syncQueued() {
    if (syncInFlightRef.current || !isSignedIn) return;

    let queued: Awaited<ReturnType<typeof loadQueuedGames>>;
    try {
      queued = await loadQueuedGames();
    } catch (err) {
      // Queue read failed (I/O error or corrupted JSON) — log and skip this
      // sync cycle rather than masking the error or crashing the app.
      console.warn('[OfflineSync] Could not read offline queue:', (err as Error).message);
      return;
    }
    if (queued.length === 0) return;

    const token = await getToken().catch(() => null);
    if (!token) return;

    syncInFlightRef.current = true;
    let synced = 0;
    try {
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
    } finally {
      syncInFlightRef.current = false;
    }
    if (synced > 0) {
      // Invalidate the all-games list (default "All Teams" view)
      qc.invalidateQueries({ queryKey: getListAllGamesQueryKey() });
      // Invalidate per-team lists for every team that had a game synced
      const syncedTeamIds = new Set(queued.map((g) => g.teamId));
      for (const teamId of syncedTeamIds) {
        qc.invalidateQueries({ queryKey: getListTeamGamesQueryKey(teamId) });
      }
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
