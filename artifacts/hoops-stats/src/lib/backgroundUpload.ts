export const PENDING_VIDEO_UPLOAD_KEY = "stec:pending-video-upload";   // legacy single-slot (still read for back-compat)
export const PENDING_VIDEO_UPLOADS_KEY = "stec:pending-video-uploads"; // current array-based queue

export type UploadStatus = 'uploading' | 'retrying' | 'attaching' | 'done' | 'failed';

export interface BackgroundUploadState {
  gameId: number;
  opponent: string;
  progress: number;
  status: UploadStatus;
  error?: string;
  retryAttempt?: number;
}

let _state: BackgroundUploadState | null = null;
const _listeners = new Set<() => void>();

// Abort controller for the current upload XHR — replaced on each attempt.
let _abortController: AbortController | null = null;

// DoUpload receives both a progress callback AND an AbortSignal so it can
// cancel the in-flight XHR immediately when the user taps Cancel.
type DoUpload = (onProgress: (pct: number) => void, signal: AbortSignal) => Promise<string | null>;
type OnVideoReady = (objectPath: string) => Promise<void>;

let _retryFns: { gameId: number; opponent: string; doUpload: DoUpload; onVideoReady: OnVideoReady } | null = null;

function notify() {
  _listeners.forEach((cb) => cb());
}

function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.name === 'TypeError' ||
    err.message.includes('Network error') ||
    err.message.includes('network') ||
    err.message.includes('Failed to fetch')
  );
}

function isCancelled(err: unknown): boolean {
  return err instanceof Error && (err.message === 'Upload cancelled' || err.name === 'AbortError');
}

async function runUpload(
  gameId: number,
  opponent: string,
  doUpload: DoUpload,
  onVideoReady: OnVideoReady,
): Promise<void> {
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    _abortController = new AbortController();
    _state = { gameId, opponent, progress: 0, status: 'uploading' };
    notify();

    try {
      const objectPath = await doUpload((pct) => {
        if (_state) {
          _state = { ..._state, progress: pct };
          notify();
        }
      }, _abortController.signal);

      if (!objectPath) {
        _state = null;
        _retryFns = null;
        _abortController = null;
        notify();
        return;
      }

      _state = { gameId, opponent, progress: 100, status: 'attaching' };
      _abortController = null;
      notify();

      await onVideoReady(objectPath);

      _state = { gameId, opponent, progress: 100, status: 'done' };
      _retryFns = null;
      notify();

      setTimeout(() => {
        if (_state?.status === 'done') {
          _state = null;
          notify();
        }
      }, 5000);
      return;
    } catch (err) {
      _abortController = null;
      if (isCancelled(err)) {
        // User explicitly cancelled — reset to idle, keep retry fns so they
        // can tap Retry if they change their mind.
        _state = { gameId, opponent, progress: 0, status: 'failed', error: 'Upload cancelled — tap Retry when ready.' };
        notify();
        return;
      }

      const errMsg = err instanceof Error ? err.message : 'Upload failed';

      if (isNetworkError(err) && attempt < MAX_ATTEMPTS) {
        const delayMs = attempt * 4000;
        _state = {
          gameId, opponent, progress: 0,
          status: 'retrying',
          retryAttempt: attempt,
          error: errMsg,
        };
        notify();
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }

      _state = { gameId, opponent, progress: 0, status: 'failed', error: errMsg };
      notify();
      return;
    }
  }
}

export const backgroundUpload = {
  subscribe(cb: () => void): () => void {
    _listeners.add(cb);
    return () => { _listeners.delete(cb); };
  },

  getSnapshot(): BackgroundUploadState | null {
    return _state;
  },

  hasRetry(): boolean {
    return _retryFns !== null;
  },

  /**
   * Cancel the in-flight XHR immediately. The status transitions to 'failed'
   * with a "tap Retry" message so the user can resume when they have signal.
   */
  cancel() {
    _abortController?.abort();
    _abortController = null;
  },

  dismiss() {
    _state = null;
    notify();
  },

  retry() {
    if (!_retryFns) return;
    const { gameId, opponent, doUpload, onVideoReady } = _retryFns;
    void runUpload(gameId, opponent, doUpload, onVideoReady);
  },

  async start(
    gameId: number,
    opponent: string,
    doUpload: DoUpload,
    onVideoReady: OnVideoReady,
  ): Promise<void> {
    _retryFns = { gameId, opponent, doUpload, onVideoReady };
    await runUpload(gameId, opponent, doUpload, onVideoReady);
  },
};
