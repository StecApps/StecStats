import AsyncStorage from '@react-native-async-storage/async-storage';
import { OFFLINE_GAME_QUEUE_KEY, SCOREKEEPER_DRAFT_KEY } from './offlineQueue';

const PENDING_UPLOAD_KEY = 'stec:pending-mobile-upload';
const PENDING_PHOTO_KEY_PREFIX = 'pending_photo_uploads_v1_';

/**
 * Remove data that is intentionally persisted on-device for recovery/retry.
 * This runs only after the server has confirmed permanent account deletion,
 * preventing a later sign-in from re-uploading a deleted game or photo.
 */
export async function clearDeletedAccountLocalData(clerkUserId?: string | null): Promise<void> {
  const keys = [
    SCOREKEEPER_DRAFT_KEY,
    OFFLINE_GAME_QUEUE_KEY,
    PENDING_UPLOAD_KEY,
  ];
  if (clerkUserId) {
    keys.push(`${PENDING_PHOTO_KEY_PREFIX}${clerkUserId}`);
  }
  await Promise.all(keys.map((key) => AsyncStorage.removeItem(key)));
}