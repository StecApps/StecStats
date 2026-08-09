/**
 * Fetches /api/storage/concat-segments with a hard AbortController timeout.
 *
 * If the server hangs and the timeout elapses, this function shows an Alert
 * offering "Retry merge" or "Save without video" and resolves the returned
 * Promise with `{ timedOut: true }` so the caller can exit cleanly.
 *
 * On success it resolves with `{ timedOut: false, videoObjectPath: string }`.
 * On a non-OK HTTP response it throws so the caller's catch block handles it.
 */

import { Alert } from 'react-native';

export const CONCAT_TIMEOUT_MS = 60_000;

export type ConcatResult =
  | { timedOut: true }
  | { timedOut: false; videoObjectPath: string };

export interface ConcatDeps {
  /** Base URL of the API server (e.g. process.env.EXPO_PUBLIC_API_BASE). */
  apiBase: string;
  /** Bearer token for the Authorization header, or null/undefined. */
  token: string | null | undefined;
  /** Segment object paths returned from individual uploads. */
  segmentPaths: string[];
  /** Called when the coach taps "Retry merge" — should restart the save flow. */
  onRetry: () => void;
  /** Called when the coach taps "Save without video". */
  onSaveWithoutVideo: () => void;
}

export async function concatSegmentsWithTimeout(deps: ConcatDeps): Promise<ConcatResult> {
  const { apiBase, token, segmentPaths, onRetry, onSaveWithoutVideo } = deps;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CONCAT_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${apiBase}/api/storage/concat-segments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ segmentPaths }),
      signal: ac.signal,
    });
  } catch (err: any) {
    clearTimeout(timer);
    if (err?.name === 'AbortError') {
      // Timed out — surface the recovery alert and signal the caller.
      await new Promise<void>((resolve) => {
        Alert.alert(
          'Merge timed out',
          'The server took too long to combine your clips. You can retry or save stats without the video.',
          [
            {
              text: 'Retry merge',
              onPress: () => { resolve(); onRetry(); },
            },
            {
              text: 'Save without video',
              style: 'default',
              onPress: () => { resolve(); onSaveWithoutVideo(); },
            },
          ],
        );
      });
      return { timedOut: true };
    }
    throw err;
  }

  clearTimeout(timer);

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error((errBody as any)?.error ?? `Concat failed (${res.status})`);
  }

  const { videoObjectPath } = await res.json();
  return { timedOut: false, videoObjectPath };
}
