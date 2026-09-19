/**
 * Daily cloud-recorded broadcaster.
 *
 * The API server owns room creation and Daily credentials.  The mobile app
 * only receives a short-lived room URL/token from POST /api/live/start.
 * After stopping, the server-side import contract is:
 * POST /api/live/:code/recording/attach { gameId }
 *
 * Daily's recording-stopped event is the authoritative recording id.  The
 * server may also resolve the newest recording by roomName when the event
 * arrives without an id (for example after an iOS background transition).
 */

export type DailyRoomCredentials = {
  url: string;
  token: string;
  roomName?: string;
};

export type DailyRecordingResult = {
  recordingId?: string;
  roomName: string;
  durationMs: number;
};

type DailyCall = {
  join: (options: { url: string; token: string; startVideoOff?: boolean; startAudioOff?: boolean }) => Promise<unknown>;
  startRecording: (options?: Record<string, unknown>) => Promise<unknown>;
  stopRecording: () => Promise<unknown>;
  leave: () => Promise<unknown>;
  destroy: () => Promise<unknown>;
  on?: (event: string, listener: (event?: any) => void) => unknown;
  off?: (event: string, listener: (event?: any) => void) => unknown;
};

type DailyModule = {
  createCallObject: () => DailyCall;
};

let activeCall: DailyCall | null = null;
let activeRoomName = '';
let recordingStartedAt = 0;
let recordingId: string | undefined;
let recordingStoppedListener: ((event?: any) => void) | undefined;

function getDailyModule(): DailyModule {
  // Keep Expo Go scorekeeping usable. Daily is a native module and is loaded
  // only when the coach explicitly starts a Daily-backed Live session.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const loaded = require('@daily-co/react-native-daily-js') as DailyModule & { default?: DailyModule };
  const daily = loaded.default ?? loaded;
  if (!daily?.createCallObject) {
    throw new Error('Daily video is unavailable in this build. Install the Daily development client.');
  }
  return daily;
}

export function isDailyBroadcastActive(): boolean {
  return activeCall !== null;
}

export function dailyRecordingElapsedMs(): number {
  return recordingStartedAt > 0 ? Math.max(0, Date.now() - recordingStartedAt) : 0;
}

export async function startDailyBroadcast(
  credentials: DailyRoomCredentials,
): Promise<void> {
  if (activeCall) return;
  if (!credentials.url || !credentials.token) {
    throw new Error('The server did not return Daily room credentials.');
  }

  const call = getDailyModule().createCallObject();
  activeCall = call;
  activeRoomName = credentials.roomName ?? credentials.url.split('/').pop() ?? '';
  recordingId = undefined;
  recordingStoppedListener = (event) => {
    recordingId =
      event?.recordingId ??
      event?.data?.recordingId ??
      event?.recording?.id ??
      recordingId;
  };
  call.on?.('recording-stopped', recordingStoppedListener);
  try {
    await call.join({
      url: credentials.url,
      token: credentials.token,
      startVideoOff: false,
      startAudioOff: false,
    });
    try {
      await call.startRecording({
        type: 'cloud',
        width: 1280,
        height: 720,
        fps: 30,
        layout: { preset: 'single-participant' },
      });
    } catch (error) {
      // The API may start the room recording before returning the broadcaster
      // token. Treat Daily's already-recording response as success; all other
      // errors still fail the Live start visibly.
      const message = error instanceof Error ? error.message : String(error);
      if (!/already\s+record|recording.*active/i.test(message)) throw error;
    }
    recordingStartedAt = Date.now();
  } catch (error) {
    await stopDailyBroadcast().catch(() => undefined);
    throw error;
  }
}

export async function stopDailyBroadcast(): Promise<DailyRecordingResult | null> {
  const call = activeCall;
  if (!call) return null;
  const durationMs = dailyRecordingElapsedMs();
  try {
    await call.stopRecording().catch(() => undefined);
    // Give the native bridge a turn to deliver recording-stopped.  The server
    // can resolve the recording by room when this event is delayed.
    await new Promise((resolve) => setTimeout(resolve, 150));
  } finally {
    if (recordingStoppedListener) call.off?.('recording-stopped', recordingStoppedListener);
    await call.leave().catch(() => undefined);
    await call.destroy().catch(() => undefined);
    activeCall = null;
    recordingStartedAt = 0;
    recordingStoppedListener = undefined;
  }
  return { recordingId, roomName: activeRoomName, durationMs };
}
