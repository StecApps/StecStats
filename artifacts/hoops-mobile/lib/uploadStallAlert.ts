/**
 * makeUploadStallHandler
 *
 * Factory that returns the onUploadStall callback used by the scorekeeper
 * save flow.  Extracted from scorekeeper.tsx so it can be unit-tested
 * without rendering the full component tree.
 *
 * The caller passes all mutable refs and state setters as plain objects /
 * functions so they can be swapped for test doubles in tests.
 */

import { Alert } from 'react-native';

export interface UploadStallDeps {
  /** Ref that prevents duplicate stall alerts from stacking. */
  stallAlertActiveRef: { current: boolean };
  /**
   * Latches to true after the coach taps "Keep waiting" once.
   * Prevents a second identical alert from firing if the upload stays
   * frozen — the coach has already been warned, so re-alerting every
   * 45 s only increases anxiety without providing new information.
   */
  stallFiredOnceRef: { current: boolean };
  /** Per-attempt cancel token; checked before showing the alert. */
  attemptToken: { cancelled: boolean };
  /** Ref to the in-flight XHR so "Save without video" can abort it. */
  uploadXhrRef: { current: XMLHttpRequest | null };
  /** Called with null to clear the progress bar, or a number to set it. */
  setUploadProgress: (v: number | null) => void;
  /** Called with false when the coach chooses to save without video. */
  setSaving: (v: boolean) => void;
  /**
   * Called with null to save stats-only (no video object path).
   * Mirrors the doSaveGame helper in scorekeeper.tsx.
   */
  doSaveGame: (videoObjectPath: string | null) => void;
  /** Called when the coach chooses to cancel the upload entirely. */
  handleCancelUpload: () => void;
}

/**
 * Returns a stable callback that can be passed directly as the `onStall`
 * argument of `uploadVideoFile`.  Each call to `makeUploadStallHandler`
 * produces a fresh closure bound to the supplied deps.
 */
export function makeUploadStallHandler(deps: UploadStallDeps): () => void {
  const {
    stallAlertActiveRef,
    stallFiredOnceRef,
    attemptToken,
    uploadXhrRef,
    setUploadProgress,
    setSaving,
    doSaveGame,
    handleCancelUpload,
  } = deps;

  return function onUploadStall() {
    if (stallAlertActiveRef.current) return;
    if (stallFiredOnceRef.current) return;
    if (attemptToken.cancelled) return;
    stallAlertActiveRef.current = true;
    Alert.alert(
      'Upload seems stuck',
      'Your connection may be slow or interrupted. You can keep waiting, save without video, or cancel.',
      [
        {
          text: 'Keep waiting',
          style: 'cancel',
          onPress: () => {
            // Latch stallFiredOnceRef so no further stall alerts appear
            // for this upload attempt — the coach has already been warned.
            stallFiredOnceRef.current = true;
            stallAlertActiveRef.current = false;
          },
        },
        {
          text: 'Save without video',
          style: 'default',
          onPress: () => {
            stallAlertActiveRef.current = false;
            attemptToken.cancelled = true;
            uploadXhrRef.current?.abort();
            uploadXhrRef.current = null;
            setUploadProgress(null);
            setSaving(false);
            doSaveGame(null);
          },
        },
        {
          text: 'Cancel upload',
          style: 'destructive',
          onPress: () => {
            stallAlertActiveRef.current = false;
            handleCancelUpload();
          },
        },
      ],
    );
  };
}
