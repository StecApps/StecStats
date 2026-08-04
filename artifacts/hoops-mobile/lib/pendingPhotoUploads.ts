/**
 * Persistence layer for photo uploads that failed mid-session.
 *
 * Each entry stores just enough to re-attempt the upload on next launch:
 * - playerId   — which player the photo belongs to
 * - uri        — local filesystem URI (from ImagePicker)
 * - mimeType   — image MIME type
 * - savedAt    — epoch ms when the failure was persisted (for pruning old entries)
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'pending_photo_uploads_v1';

// Entries older than 7 days are pruned automatically (URI is gone by then).
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface PendingPhotoUpload {
  playerId: number;
  uri: string;
  mimeType: string;
  savedAt: number;
}

async function load(): Promise<PendingPhotoUpload[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: PendingPhotoUpload[] = JSON.parse(raw);
    // Prune stale entries while we're here.
    const cutoff = Date.now() - MAX_AGE_MS;
    return parsed.filter((e) => e.savedAt >= cutoff);
  } catch {
    return [];
  }
}

async function save(entries: PendingPhotoUpload[]): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Best-effort — don't crash if storage is unavailable.
  }
}

/** Persist a failed upload so it can be retried on next launch. */
export async function addPendingPhotoUpload(
  entry: Omit<PendingPhotoUpload, 'savedAt'>,
): Promise<void> {
  const existing = await load();
  // Deduplicate by playerId — keep only the latest attempt per player.
  const filtered = existing.filter((e) => e.playerId !== entry.playerId);
  filtered.push({ ...entry, savedAt: Date.now() });
  await save(filtered);
}

/** Remove all pending uploads for a specific player (e.g. after success). */
export async function clearPendingPhotoUpload(playerId: number): Promise<void> {
  const existing = await load();
  await save(existing.filter((e) => e.playerId !== playerId));
}

/** Return all pending uploads that should be retried. */
export async function getPendingPhotoUploads(): Promise<PendingPhotoUpload[]> {
  return load();
}
