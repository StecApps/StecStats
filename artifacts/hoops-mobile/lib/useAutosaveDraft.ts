/**
 * useAutosaveDraft
 *
 * Debounced autosave hook for the scorekeeper screen.  Waits 2 s after the
 * last state change before writing a ScorekeeperDraft snapshot to
 * AsyncStorage, so rapid stat taps don't hammer the storage layer.
 *
 * The `saving` flag is intentionally NOT in the dependency array — the guard
 * is sampled at effect-run time (i.e. whenever a score field changes).  This
 * matches the original inline implementation in scorekeeper.tsx and is the
 * single source of truth that tests exercise.
 */

import { useRef, useEffect } from 'react';
import { saveDraft, type ScorekeeperDraft } from './offlineQueue';
import type { StatLine, GameEvent } from './saveGame';

export interface UseAutosaveDraftParams {
  teamId: number;
  teamName: string;
  opponent: string;
  date: string;
  stats: Record<number, StatLine>;
  events: GameEvent[];
  opponentScore: number;
  teamScoreAdj: number;
  half: 1 | 2;
  seconds: number;
  /** When true the debounce is skipped — autosave must not overwrite the
   *  active save/upload flow. */
  saving: boolean;
}

export const AUTOSAVE_DEBOUNCE_MS = 2_000;

export function useAutosaveDraft({
  teamId,
  teamName,
  opponent,
  date,
  stats,
  events,
  opponentScore,
  teamScoreAdj,
  half,
  seconds,
  saving,
}: UseAutosaveDraftParams): void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (saving) return; // don't overwrite during the save flow
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const draft: ScorekeeperDraft = {
        teamId,
        teamName,
        opponent,
        date,
        stats,
        events,
        opponentScore,
        teamScoreAdj,
        half,
        seconds,
        savedAt: new Date().toISOString(),
      };
      saveDraft(draft);
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // saving is intentionally omitted — sampled at effect-run time only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stats, events, opponentScore, teamScoreAdj, half, seconds]);
}
