/**
 * On mount (once the user is signed in), checks AsyncStorage for any photo
 * uploads that failed in a previous session and retries them in the background.
 *
 * Shows a brief Alert to let the coach know the outcome.
 */

import { useEffect, useRef } from 'react';
import { Alert } from 'react-native';
import { useAuth } from '@clerk/clerk-expo';
import { useQueryClient } from '@tanstack/react-query';
import {
  getPendingPhotoUploads,
  clearPendingPhotoUpload,
} from '@/lib/pendingPhotoUploads';
import { getListPlayersQueryKey } from '@workspace/api-client-react';

const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}`
  : '';

async function uploadPhoto(
  uri: string,
  mimeType: string,
  token: string,
): Promise<string> {
  let reqRes: Response;
  try {
    reqRes = await fetch(`${API_BASE}/api/storage/uploads/request-url`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        name: `player-photo-${Date.now()}.jpg`,
        size: 0,
        contentType: mimeType || 'image/jpeg',
      }),
    });
  } catch {
    throw new Error('Network error');
  }
  if (!reqRes.ok) throw new Error(`Request failed (${reqRes.status})`);
  const { uploadURL, objectPath } = await reqRes.json();

  let blob: Blob;
  try {
    blob = await (await fetch(uri)).blob();
  } catch {
    throw new Error('Could not read saved photo');
  }

  let upRes: Response;
  try {
    upRes = await fetch(uploadURL, {
      method: 'PUT',
      headers: { 'Content-Type': mimeType || 'image/jpeg' },
      body: blob,
    });
  } catch {
    throw new Error('Network error during upload');
  }
  if (!upRes.ok) throw new Error(`Upload failed (${upRes.status})`);
  return objectPath;
}

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
      const pending = await getPendingPhotoUploads(userId);
      if (pending.length === 0) return;

      const token = await getToken();
      if (!token) return; // Not authenticated yet — will retry next launch.

      let successCount = 0;
      let failCount = 0;

      for (const entry of pending) {
        try {
          const objectPath = await uploadPhoto(entry.uri, entry.mimeType, token);
          await updatePlayerPhoto(entry.playerId, objectPath, token);
          await clearPendingPhotoUpload(userId, entry.playerId);
          successCount++;
        } catch {
          failCount++;
        }
      }

      // Refresh the player list if anything changed.
      if (successCount > 0) {
        qc.invalidateQueries({ queryKey: getListPlayersQueryKey() });
      }

      // Brief indication of outcome.
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
            ? `1 pending photo upload failed again${successCount > 0 ? ` (${successCount} succeeded)` : ''}. Tap the player's avatar to try again.`
            : `${failCount} pending photo uploads failed again${successCount > 0 ? ` (${successCount} succeeded)` : ''}. Tap a player's avatar to retry.`,
          [{ text: 'OK' }],
        );
      }
    })();
  }, [isSignedIn, userId]);
}
