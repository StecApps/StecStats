/**
 * Persistence layer for photo uploads that failed mid-session.
 *
 * Each entry stores just enough to re-attempt the upload on next launch:
 * - playerId   — which player the photo belongs to
 * - uri        — local filesystem URI (from ImagePicker)
 * - mimeType   — image MIME type
 * - savedAt    — epoch ms when the failure was persisted (for pruning old entries)
 *
 * The queue is keyed by Clerk userId so each coach on a shared device
 * has an isolated namespace — a new sign-in never retries a previous
 * coach's uploads.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY_PREFIX = 'pending_photo_uploads_v1_';

function storageKey(userId: string): string {
  return `${KEY_PREFIX}${userId}`;
}

// Entries older than 7 days are pruned automatically (URI is gone by then).
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface PendingPhotoUpload {
  playerId: number;
  uri: string;
  mimeType: string;
  savedAt: number;
}

async function load(userId: string): Promise<PendingPhotoUpload[]> {
  try {
    const raw = await AsyncStorage.getItem(storageKey(userId));
    if (!raw) return [];
    const parsed: PendingPhotoUpload[] = JSON.parse(raw);
    // Prune stale entries while we're here.
    const cutoff = Date.now() - MAX_AGE_MS;
    return parsed.filter((e) => e.savedAt >= cutoff);
  } catch {
    return [];
  }
}

async function save(userId: string, entries: PendingPhotoUpload[]): Promise<void> {
  try {
    await AsyncStorage.setItem(storageKey(userId), JSON.stringify(entries));
  } catch {
    // Best-effort — don't crash if storage is unavailable.
  }
}

/** Persist a failed upload so it can be retried on next launch. */
export async function addPendingPhotoUpload(
  userId: string,
  entry: Omit<PendingPhotoUpload, 'savedAt'>,
): Promise<void> {
  const existing = await load(userId);
  // Deduplicate by playerId — keep only the latest attempt per player.
  const filtered = existing.filter((e) => e.playerId !== entry.playerId);
  filtered.push({ ...entry, savedAt: Date.now() });
  await save(userId, filtered);
}

/** Remove all pending uploads for a specific player (e.g. after success). */
export async function clearPendingPhotoUpload(userId: string, playerId: number): Promise<void> {
  const existing = await load(userId);
  await save(userId, existing.filter((e) => e.playerId !== playerId));
}

/** Return all pending uploads that should be retried. */
export async function getPendingPhotoUploads(userId: string): Promise<PendingPhotoUpload[]> {
  return load(userId);
}

/** Remove the entire queue for a user (e.g. on sign-out). */
export async function clearAllPendingPhotoUploads(userId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(storageKey(userId));
  } catch {
    // Best-effort.
  }
}
