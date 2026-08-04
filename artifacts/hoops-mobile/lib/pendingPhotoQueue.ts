/**
 * Persistent queue for photo uploads that failed mid-game.
 * Backed by AsyncStorage so entries survive app force-close.
 *
 * The queue is keyed by Clerk userId so each coach on a shared device
 * has an isolated namespace — a new sign-in never retries a previous
 * coach's uploads.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';


/** Entries older than this are silently pruned on queue read. */
export const PENDING_PHOTO_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface PendingPhotoEntry {
  id: string;          // unique entry ID (Date.now + random)
  uri: string;         // local asset URI
  mimeType: string;
  playerId: number;
  addedAt: number;     // unix ms
}

async function readQueue(userId: string): Promise<PendingPhotoEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(storageKey(userId));
    if (!raw) return [];
    const entries = JSON.parse(raw) as PendingPhotoEntry[];

    const now = Date.now();
    const fresh = entries.filter((e) => now - e.addedAt < PENDING_PHOTO_TTL_MS);
    const pruned = entries.length - fresh.length;

    if (pruned > 0) {
      if (__DEV__) {
        console.log(`[pendingPhotoQueue] pruned ${pruned} expired entr${pruned === 1 ? 'y' : 'ies'} (>${PENDING_PHOTO_TTL_MS / 86400000}d old)`);
      }
      // Persist the pruned list so they don't accumulate across reads.
      await AsyncStorage.setItem(storageKey(userId), JSON.stringify(fresh));
    }

    return fresh;
  } catch {
    return [];
  }
}

async function writeQueue(userId: string, entries: PendingPhotoEntry[]): Promise<void> {
  await AsyncStorage.setItem(storageKey(userId), JSON.stringify(entries));
}

/** Adds a failed upload to the queue and returns its entry ID. */
export async function enqueuePhoto(
  userId: string,
  uri: string,
  mimeType: string,
  playerId: number,
): Promise<string> {
  const queue = await readQueue(userId);
  const entry: PendingPhotoEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    uri,
    mimeType,
    playerId,
    addedAt: Date.now(),
  };
  queue.push(entry);
  await writeQueue(userId, queue);
  return entry.id;
}

export async function dequeuePhoto(userId: string, id: string): Promise<void> {
  const queue = await readQueue(userId);
  await writeQueue(userId, queue.filter((e) => e.id !== id));
}

export async function getPendingPhotos(userId: string): Promise<PendingPhotoEntry[]> {
  return readQueue(userId);
}

/** Remove the entire queue for a user (e.g. on sign-out). */
export async function clearPendingPhotos(userId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(storageKey(userId));
  } catch {
    // Best-effort.
  }
}

const KEY_PREFIX = 'pending_photo_uploads_v1_';

function storageKey(userId: string): string {
  return `${KEY_PREFIX}${userId}`;
}
