export type UploadStatus = 'uploading' | 'attaching' | 'done' | 'failed';

export interface BackgroundUploadState {
  gameId: number;
  opponent: string;
  progress: number;
  status: UploadStatus;
  error?: string;
}

let _state: BackgroundUploadState | null = null;
const _listeners = new Set<() => void>();

function notify() {
  _listeners.forEach((cb) => cb());
}

export const backgroundUpload = {
  subscribe(cb: () => void): () => void {
    _listeners.add(cb);
    return () => { _listeners.delete(cb); };
  },

  getSnapshot(): BackgroundUploadState | null {
    return _state;
  },

  dismiss() {
    _state = null;
    notify();
  },

  async start(
    gameId: number,
    opponent: string,
    doUpload: (onProgress: (pct: number) => void) => Promise<string | null>,
    onVideoReady: (objectPath: string) => Promise<void>,
  ): Promise<void> {
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
        notify();
        return;
      }

      _state = { ..._state!, status: 'attaching', progress: 100 };
      notify();

      await onVideoReady(objectPath);

      _state = { ..._state!, status: 'done' };
      notify();

      setTimeout(() => {
        _state = null;
        notify();
      }, 5000);
    } catch (err) {
      _state = {
        ..._state!,
        status: 'failed',
        error: err instanceof Error ? err.message : 'Upload failed',
      };
      notify();
    }
  },
};
