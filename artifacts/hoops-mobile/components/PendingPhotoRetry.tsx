/**
 * On every app open, silently retries any photo uploads that failed last session.
 * Runs only when the user is signed in so we have a valid auth token.
 * On failure keeps the entry in the queue; shows a single alert listing how many
 * photos still couldn't be uploaded so the coach knows to try again.
 *
 * Extracted into its own file so it can be unit-tested independently of the
 * full RootLayout tree (which pulls in heavy native modules).
 */
import React, { useEffect, useRef } from 'react';
import { Alert } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@clerk/clerk-expo';
import { useUpdatePlayer, getListPlayersQueryKey } from '@workspace/api-client-react';
import { getPendingPhotos, dequeuePhoto } from '@/lib/pendingPhotoQueue';
import { uploadPhoto } from '@/lib/photoUpload';

export function PendingPhotoRetry() {
  const { isSignedIn, getToken } = useAuth();
  const updatePlayer = useUpdatePlayer();
  const qc = useQueryClient();
  const hasRun = useRef(false);

  useEffect(() => {
    if (!isSignedIn || hasRun.current) return;
    hasRun.current = true;

    (async () => {
      const pending = await getPendingPhotos();
      if (pending.length === 0) return;

      let failCount = 0;
      for (const entry of pending) {
        try {
          const token = await getToken();
          if (!token) {
            failCount += pending.length;
            break;
          }
          const objectPath = await uploadPhoto(entry.uri, entry.mimeType, token);
          await updatePlayer.mutateAsync({
            playerId: entry.playerId,
            data: { photoObjectPath: objectPath },
          });
          qc.invalidateQueries({ queryKey: getListPlayersQueryKey() });
          await dequeuePhoto(entry.id);
        } catch {
          failCount++;
        }
      }

      if (failCount > 0) {
        Alert.alert(
          'Photo upload incomplete',
          `${failCount} player photo${failCount > 1 ? 's' : ''} couldn't be uploaded. Open the player's profile and tap their photo to try again.`,
          [{ text: 'OK' }],
        );
      }
    })();
  }, [isSignedIn]);

  return null;
}
