/**
 * On mount (once the user is signed in), checks AsyncStorage for any photo
 * uploads that failed in a previous session and retries them in the background.
 *
 * Reads from the same queue (`pendingPhotoQueue`) that the dashboard's
 * `attemptUpload` writes to, so entries are always visible to the retry hook.
 *
 * Uses the shared `uploadPhoto` helper from `photoUpload.ts` which fetches
 * the real blob size before requesting a signed URL — avoiding the size:0
 * rejection from the server's Zod schema (size must be >= 1).
 */

import { useEffect, useRef } from 'react';
import { Alert } from 'react-native';
import { useAuth } from '@clerk/expo';
import { useQueryClient } from '@tanstack/react-query';
import { getPendingPhotos, dequeuePhoto } from '@/lib/pendingPhotoQueue';
import { uploadPhoto, API_BASE } from '@/lib/photoUpload';
import { getListPlayersQueryKey } from '@workspace/api-client-react';

async function updatePlayerPhoto(
  playerId: number,
  photoObjectPath: string,
  token: string,
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/players/${playerId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ photoObjectPath }),
  });
  if (!res.ok) throw new Error(`Player update failed (${res.status})`);
}

export function usePendingPhotoRetry() {
  const { isSignedIn, userId, getToken } = useAuth();
  const qc = useQueryClient();
  const hasRun = useRef(false);

  useEffect(() => {
    // Only run once per session, after the user is confirmed signed in.
    if (!isSignedIn || !userId || hasRun.current) return;
    hasRun.current = true;

    (async () => {
      const pending = await getPendingPhotos(userId);
      if (pending.length === 0) return;

      const token = await getToken();
      if (!token) return; // Not authenticated yet — will retry next launch.

      let successCount = 0;
      let failCount = 0;

      for (const entry of pending) {
        try {
          // uploadPhoto fetches the real blob size before requesting the
          // signed URL, so the server's size >= 1 validation always passes.
          const objectPath = await uploadPhoto(entry.uri, entry.mimeType, token);
          await updatePlayerPhoto(entry.playerId, objectPath, token);
          await dequeuePhoto(userId, entry.id);
          successCount++;
        } catch {
          failCount++;
        }
      }

      // Refresh the player list if anything changed.
      if (successCount > 0) {
        qc.invalidateQueries({ queryKey: getListPlayersQueryKey() });
      }

      if (successCount > 0 && failCount === 0) {
        Alert.alert(
          'Photo uploaded',
          successCount === 1
            ? 'A pending player photo was uploaded successfully.'
            : `${successCount} pending player photos were uploaded successfully.`,
          [{ text: 'OK' }],
        );
      } else if (failCount > 0) {
        Alert.alert(
          'Photo upload',
          failCount === 1
            ? `1 pending photo upload failed again${successCount > 0 ? ` (${successCount} succeeded)` : ''}. Tap the player\u2019s avatar to try again.`
            : `${failCount} pending photo uploads failed again${successCount > 0 ? ` (${successCount} succeeded)` : ''}. Tap a player\u2019s avatar to retry.`,
          [{ text: 'OK' }],
        );
      }
    })();
  }, [isSignedIn, userId]);
}
