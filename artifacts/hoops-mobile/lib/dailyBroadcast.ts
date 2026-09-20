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
  setLocalAudio: (enabled: boolean) => DailyCall;
  cycleCamera: () => Promise<{ device: { facingMode: 'user' | 'environment' } | null }>;
  participants?: () => {
    local?: {
      local?: boolean;
      videoTrack?: unknown | false;
      tracks?: { video?: { persistentTrack?: unknown } };
    };
  };
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
let participantUpdatedListener: ((event?: any) => void) | undefined;
let localVideoTrackListener: ((track: unknown | null) => void) | undefined;

function readLocalVideoTrack(participant?: {
  videoTrack?: unknown | false;
  tracks?: { video?: { persistentTrack?: unknown } };
}): unknown | null {
  return participant?.tracks?.video?.persistentTrack ?? participant?.videoTrack ?? null;
}

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

export async function cycleDailyCamera(): Promise<'front' | 'back' | null> {
  if (!activeCall) return null;
  const result = await activeCall.cycleCamera();
  return result.device?.facingMode === 'user'
    ? 'front'
    : result.device?.facingMode === 'environment'
      ? 'back'
      : null;
}

export function setDailyMicrophoneMuted(muted: boolean): void {
  activeCall?.setLocalAudio(!muted);
}

export async function startDailyBroadcast(
  credentials: DailyRoomCredentials,
  onLocalVideoTrack?: (track: unknown | null) => void,
): Promise<void> {
  if (activeCall) return;
  if (!credentials.url || !credentials.token) {
    throw new Error('The server did not return Daily room credentials.');
  }

  const call = getDailyModule().createCallObject();
  activeCall = call;
  activeRoomName = credentials.roomName ?? credentials.url.split('/').pop() ?? '';
  recordingId = undefined;
  localVideoTrackListener = onLocalVideoTrack;
  recordingStoppedListener = (event) => {
    recordingId =
      event?.recordingId ??
      event?.data?.recordingId ??
      event?.recording?.id ??
      recordingId;
  };
  call.on?.('recording-stopped', recordingStoppedListener);
  participantUpdatedListener = (event) => {
    const participant = event?.participant;
    if (participant?.local) {
      localVideoTrackListener?.(readLocalVideoTrack(participant));
    }
  };
  call.on?.('participant-updated', participantUpdatedListener);
  try {
    await call.join({
      url: credentials.url,
      token: credentials.token,
      startVideoOff: false,
      startAudioOff: false,
    });
    localVideoTrackListener?.(readLocalVideoTrack(call.participants?.()?.local));
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
    if (participantUpdatedListener) call.off?.('participant-updated', participantUpdatedListener);
    localVideoTrackListener?.(null);
    await call.leave().catch(() => undefined);
    await call.destroy().catch(() => undefined);
    activeCall = null;
    recordingStartedAt = 0;
    recordingStoppedListener = undefined;
    participantUpdatedListener = undefined;
    localVideoTrackListener = undefined;
  }
  return { recordingId, roomName: activeRoomName, durationMs };
}
