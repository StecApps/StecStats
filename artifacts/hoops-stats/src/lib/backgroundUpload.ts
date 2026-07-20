export const PENDING_VIDEO_UPLOAD_KEY = "stec:pending-video-upload";

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

type DoUpload = (onProgress: (pct: number) => void) => Promise<string | null>;
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

async function runUpload(
  gameId: number,
  opponent: string,
  doUpload: DoUpload,
  onVideoReady: OnVideoReady,
): Promise<void> {
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    _state = { gameId, opponent, progress: 0, status: 'uploading' };
    notify();

    try {
      const objectPath = await doUpload((pct) => {
        if (_state) {
          _state = { ..._state, progress: pct };
          notify();
        }
      });

      if (!objectPath) {
        _state = null;
        _retryFns = null;
        notify();
        return;
      }

      _state = { gameId, opponent, progress: 100, status: 'attaching' };
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

  dismiss() {
    _state = null;
    notify();
  },

  retry() {
    if (!_retryFns) return;
    const { gameId, opponent, doUpload, onVideoReady } = _retryFns;
    runUpload(gameId, opponent, doUpload, onVideoReady);
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
