/**
 * Persistent queue for photo uploads that failed mid-game.
 * Backed by AsyncStorage so entries survive app force-close.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'pending_photo_uploads_v1';

/** Entries older than this are silently pruned on queue read. */
export const PENDING_PHOTO_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface PendingPhotoEntry {
  id: string;          // unique entry ID (Date.now + random)
  uri: string;         // local asset URI
  mimeType: string;
  playerId: number;
  addedAt: number;     // unix ms
}

async function readQueue(): Promise<PendingPhotoEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
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
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
    }

    return fresh;
  } catch {
    return [];
  }
}

async function writeQueue(entries: PendingPhotoEntry[]): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

/** Adds a failed upload to the queue and returns its entry ID. */
export async function enqueuePhoto(
  uri: string,
  mimeType: string,
  playerId: number,
): Promise<string> {
  const queue = await readQueue();
  const entry: PendingPhotoEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    uri,
    mimeType,
    playerId,
    addedAt: Date.now(),
  };
  queue.push(entry);
  await writeQueue(queue);
  return entry.id;
}

export async function dequeuePhoto(id: string): Promise<void> {
  const queue = await readQueue();
  await writeQueue(queue.filter((e) => e.id !== id));
}

export async function getPendingPhotos(): Promise<PendingPhotoEntry[]> {
  return readQueue();
}
