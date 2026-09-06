import AsyncStorage from '@react-native-async-storage/async-storage';
import { concatSegmentsWithTimeout } from './concatSegmentsWithTimeout';
import { uploadVideoFile } from './uploadVideoFile';
import { type GameEvent, type StatLine } from './saveGame';

/** Durable marker for a recorded full-game master. Never remove before attach. */
export const PENDING_UPLOAD_KEY = 'stec:pending-mobile-upload';
// Both the scorekeeper and app-level recovery worker run in this JS runtime.
// A single process-wide lease serializes them around the one AsyncStorage item.
let pendingMasterLeaseHeld = false;

export function tryAcquirePendingMasterLease(): boolean {
  if (pendingMasterLeaseHeld) return false;
  pendingMasterLeaseHeld = true;
  return true;
}

export function releasePendingMasterLease(): void {
  pendingMasterLeaseHeld = false;
}

export interface PendingUpload {
  uris: string[];
  teamId: number;
  teamName: string;
  opponent: string;
  date: string;
  teamScore: number;
  opponentScore: number;
  stats: Record<number, StatLine>;
  events: GameEvent[];
  /** Stable across relaunches so creating the game is idempotent. */
  clientId: string;
  /** Persisted as soon as metadata creation is acknowledged. */
  gameId?: number;
  /** Avoid uploading already-completed segments after an interrupted retry. */
  uploadedPaths?: string[];
  videoObjectPath?: string;
  savedAt: string;
}

export interface PendingMasterUploadDeps {
  apiBase: string;
  getToken: () => Promise<string | null>;
  requestUploadUrl: (body: { name: string; size: number; contentType: string }) => Promise<{ uploadURL: string; objectPath: string }>;
  onProgress?: (percent: number) => void;
}

async function writePending(pending: PendingUpload) {
  await AsyncStorage.setItem(PENDING_UPLOAD_KEY, JSON.stringify(pending));
}

/** Persist a foreground transition without allowing it to replace its clientId. */
export async function updatePendingMasterUpload(
  update: Partial<Pick<PendingUpload, 'gameId' | 'uploadedPaths' | 'videoObjectPath'>>,
): Promise<void> {
  const current = await loadPendingMasterUpload();
  if (!current) return;
  await writePending({ ...current, ...update });
}

function gamePayload(pending: PendingUpload, videoObjectPath?: string) {
  const stats = Object.entries(pending.stats).map(([playerId, line]) => ({
    playerId: Number(playerId),
    ...line,
  }));
  return {
    clientId: pending.clientId,
    teamId: pending.teamId,
    opponent: pending.opponent,
    date: pending.date,
    result: pending.teamScore > pending.opponentScore ? 'W' : 'L',
    teamScore: pending.teamScore,
    opponentScore: pending.opponentScore,
    stats,
    events: pending.events,
    ...(videoObjectPath ? { videoObjectPath } : {}),
  };
}

async function authenticatedFetch(deps: PendingMasterUploadDeps, url: string, init: RequestInit) {
  const token = await deps.getToken();
  if (!token) throw new Error('Sign in is required to upload this recording.');
  const res = await fetch(`${deps.apiBase}${url}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`Server error (${res.status})`);
  return res;
}

/**
 * Recovers a complete game master after offline end-game, relaunch, or a failed
 * upload. Every durable transition is written before the next network step.
 * The marker is removed only after PATCH has confirmed videoObjectPath attach.
 */
export async function syncPendingMasterUpload(
  initial: PendingUpload,
  deps: PendingMasterUploadDeps,
): Promise<{ gameId: number }> {
  let pending = initial;

  // Creating metadata first makes the game visible in Filming and gives retries
  // a stable server row. POST is safely deduplicated by clientId.
  if (!pending.gameId) {
    const created = await authenticatedFetch(deps, '/api/games', {
      method: 'POST',
      body: JSON.stringify(gamePayload(pending)),
    });
    const game = await created.json() as { id: number };
    if (!game.id) throw new Error('Game metadata was not acknowledged by the server.');
    pending = { ...pending, gameId: game.id };
    await writePending(pending);
  }

  let uploadedPaths = pending.uploadedPaths ?? [];
  for (let index = uploadedPaths.length; index < pending.uris.length; index++) {
    const path = await uploadVideoFile(
      pending.uris[index],
      deps.requestUploadUrl,
      (pct) => deps.onProgress?.(Math.round(((index + pct / 100) / pending.uris.length) * 90)),
    );
    uploadedPaths = [...uploadedPaths, path];
    pending = { ...pending, uploadedPaths };
    await writePending(pending);
  }

  let videoObjectPath = pending.videoObjectPath;
  if (!videoObjectPath) {
    if (uploadedPaths.length === 0) throw new Error('No local recording was available to upload.');
    if (uploadedPaths.length === 1) {
      videoObjectPath = uploadedPaths[0];
    } else {
      const token = await deps.getToken();
      const merged = await concatSegmentsWithTimeout({
        apiBase: deps.apiBase,
        token,
        segmentPaths: uploadedPaths,
        onRetry: () => {},
        onSaveWithoutVideo: () => {},
      });
      if (merged.timedOut) throw new Error('Video merge is still pending; the master remains saved on this device.');
      videoObjectPath = merged.videoObjectPath;
    }
    pending = { ...pending, videoObjectPath };
    await writePending(pending);
  }

  // This owner-scoped endpoint changes only the master attachment. Do not use
  // the full game PUT here: a relaunch must never rewrite completed stats.
  const attachResponse = await authenticatedFetch(deps, `/api/games/${pending.gameId}/video`, {
    method: 'PATCH',
    body: JSON.stringify({ videoObjectPath }),
  });
  if (attachResponse.status !== 200) {
    throw new Error(`Video attachment was not confirmed (HTTP ${attachResponse.status}).`);
  }

  // The server endpoints coalesce already-processing jobs, so retries are safe.
  // Do this after attach; failure here never causes the local master to vanish.
  const generation = await Promise.allSettled([
    authenticatedFetch(deps, `/api/games/${pending.gameId}/highlight`, { method: 'POST', body: '{}' }),
    authenticatedFetch(deps, `/api/games/${pending.gameId}/lowlight`, { method: 'POST', body: '{}' }),
  ]);
  // A 400 is a valid terminal result for a reel with no eligible moments
  // (especially lowlights). Network/5xx failures retain the marker so both
  // idempotent generation requests are retried on the next recovery cycle.
  const retryableGenerationError = generation.find((result) =>
    result.status === 'rejected' && !String(result.reason?.message ?? result.reason).includes('Server error (400)'),
  );
  if (retryableGenerationError?.status === 'rejected') throw retryableGenerationError.reason;

  await AsyncStorage.removeItem(PENDING_UPLOAD_KEY);
  return { gameId: pending.gameId! };
}

/** Lease-aware entry point used exclusively by automatic recovery. */
export async function syncPendingMasterUploadIfAvailable(
  pending: PendingUpload,
  deps: PendingMasterUploadDeps,
): Promise<{ gameId: number } | null> {
  if (!tryAcquirePendingMasterLease()) return null;
  try {
    return await syncPendingMasterUpload(pending, deps);
  } finally {
    releasePendingMasterLease();
  }
}

export async function loadPendingMasterUpload(): Promise<PendingUpload | null> {
  const raw = await AsyncStorage.getItem(PENDING_UPLOAD_KEY);
  if (!raw) return null;
  const parsed = JSON.parse(raw) as Partial<PendingUpload>;
  if (!Array.isArray(parsed.uris) || !parsed.clientId || !parsed.teamId) {
    throw new Error('Pending master recording is invalid.');
  }
  return parsed as PendingUpload;
}