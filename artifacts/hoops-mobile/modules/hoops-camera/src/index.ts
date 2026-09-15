import type { ComponentType } from 'react';
import type { ViewProps } from 'react-native';
import { requireNativeView, requireOptionalNativeModule } from 'expo';
import type { MediaStream as RTCMediaStream, MediaStreamTrack as RTCMediaStreamTrack } from 'react-native-webrtc';

export type EventSubscription = { remove(): void };

export const HOOPS_CAMERA_MODULE_NAME = 'HoopsCamera';

export type CameraFacing = 'back' | 'front';

export type HoopsCameraPermissionStatus = {
  camera: 'undetermined' | 'denied' | 'granted';
  microphone: 'undetermined' | 'denied' | 'granted';
};

export type HoopsCameraRecording = {
  /** A file:// URI in the app's caches directory. */
  uri: string;
};

export type HoopsCameraState = 'idle' | 'previewing' | 'recording' | 'paused' | 'stopped';

export type HoopsCameraStateEvent = {
  state: HoopsCameraState;
  isRecording: boolean;
  reason?: string;
  interruptionId?: string;
  timestampMs?: number;
};

export type HoopsCameraErrorEvent = {
  code: string;
  message: string;
  recoverable: boolean;
};

export type HoopsCameraRecordingEvent = HoopsCameraRecording & {
  usable?: boolean;
  reason?: string;
  interruptionId?: string;
  timestampMs?: number;
};

export type HoopsCameraLifecycleResumeEvent = {
  interruptionId?: string;
  timestampMs?: number;
  interruptedAtMs?: number;
  finalizationComplete?: boolean;
  finalizedUri?: string;
};

export type HoopsCameraEventMap = {
  onStateChange: (event: HoopsCameraStateEvent) => void;
  onError: (event: HoopsCameraErrorEvent) => void;
  onRecordingFinished: (event: HoopsCameraRecordingEvent) => void;
  onLifecycleResume: (event: HoopsCameraLifecycleResumeEvent) => void;
};

export type HoopsCameraViewProps = ViewProps & {
  active?: boolean;
  facing?: CameraFacing;
  /** Normalized zoom from 0 (1x) to 1 (the device's maximum). */
  zoom?: number;
  onPreviewReady?: (event: { nativeEvent: { state: 'previewing' } }) => void;
  onPreviewError?: (event: { nativeEvent: HoopsCameraErrorEvent }) => void;
};

type HoopsCameraNativeModule = {
  getPermissionStatusAsync(): Promise<HoopsCameraPermissionStatus>;
  requestPermissionsAsync(): Promise<HoopsCameraPermissionStatus>;
  startRecordingAsync(muted: boolean): Promise<HoopsCameraRecording>;
  stopRecordingAsync(): Promise<HoopsCameraRecording>;
  setMicrophoneMutedAsync(muted: boolean): Promise<void>;
  setFacingAsync(facing: CameraFacing): Promise<void>;
  setZoomAsync(zoom: number): Promise<void>;
  addListener<EventName extends keyof HoopsCameraEventMap>(
    eventName: EventName,
    listener: HoopsCameraEventMap[EventName],
  ): EventSubscription;
};

type HoopsCameraWebRTCNativeStreamInfo = {
  streamId: string;
  track: {
    enabled: boolean;
    id: string;
    kind: 'video';
    readyState: 'live';
    remote: false;
    settings: Record<string, never>;
  };
};

type HoopsCameraWebRTCNativeModule = {
  createHoopsCameraVideoStream(): Promise<HoopsCameraWebRTCNativeStreamInfo>;
  releaseHoopsCameraVideoStream(): Promise<void>;
  createHoopsCameraVideoStreamNative?(): Promise<HoopsCameraWebRTCNativeStreamInfo>;
  releaseHoopsCameraVideoStreamNative?(): Promise<void>;
};

export type HoopsCameraLiveVideo = {
  /** The native video track backed by HoopsCamera's existing capture session. */
  track: RTCMediaStreamTrack;
  /** The stream containing track, suitable for RTCPeerConnection.addTrack. */
  stream: RTCMediaStream;
};

type HoopsCameraEventEmitter = Pick<HoopsCameraNativeModule, 'addListener'>;

/**
 * Optional on purpose: importing this facade in Expo Go must not crash.
 * A development client/local iOS build reports true once the autolinked module
 * is present. This module does not provide a JS or WebRTC recording fallback.
 */
const nativeModule = requireOptionalNativeModule<HoopsCameraNativeModule>(
  HOOPS_CAMERA_MODULE_NAME,
);

export const isHoopsCameraAvailable = nativeModule !== null;

function getHoopsCameraWebRTCNativeModule(): HoopsCameraWebRTCNativeModule | null {
  if (nativeModule === null) {
    return null;
  }

  try {
    // Keep this lookup lazy: importing react-native-webrtc itself throws when a
    // development client was built without its native module.
    const { NativeModules } = require('react-native') as {
      NativeModules?: { WebRTCModule?: Partial<HoopsCameraWebRTCNativeModule> };
    };
    const bridge = NativeModules?.WebRTCModule;
    const hasPrimaryExports =
      typeof bridge?.createHoopsCameraVideoStreamNative === 'function' &&
      typeof bridge?.releaseHoopsCameraVideoStreamNative === 'function';
    const hasCategoryExports =
      typeof bridge?.createHoopsCameraVideoStream === 'function' &&
      typeof bridge?.releaseHoopsCameraVideoStream === 'function';
    if (bridge && (hasPrimaryExports || hasCategoryExports)) {
      return bridge as HoopsCameraWebRTCNativeModule;
    }
  } catch {
    // Feature detection must remain safe in Expo Go and on web.
  }

  return null;
}

export function isHoopsCameraWebRTCAvailable(): boolean {
  return getHoopsCameraWebRTCNativeModule() !== null;
}

export const HoopsCameraView: ComponentType<HoopsCameraViewProps> | null =
  nativeModule === null
    ? null
    : requireNativeView<HoopsCameraViewProps>(HOOPS_CAMERA_MODULE_NAME);

const events = nativeModule
  ? (nativeModule as unknown as HoopsCameraEventEmitter)
  : null;

function requireHoopsCamera(): HoopsCameraNativeModule {
  if (nativeModule === null) {
    throw new Error(
      'HoopsCamera is unavailable. Use an iOS development client/local build with the local module autolinked; Expo Go is not supported.',
    );
  }
  return nativeModule;
}

export function addHoopsCameraListener<EventName extends keyof HoopsCameraEventMap>(
  eventName: EventName,
  listener: HoopsCameraEventMap[EventName],
): EventSubscription {
  if (events === null) {
    return { remove: () => undefined };
  }
  return events.addListener(eventName, listener);
}

export function getHoopsCameraPermissionStatusAsync(): Promise<HoopsCameraPermissionStatus> {
  return requireHoopsCamera().getPermissionStatusAsync();
}

export function requestHoopsCameraPermissionsAsync(): Promise<HoopsCameraPermissionStatus> {
  return requireHoopsCamera().requestPermissionsAsync();
}

export function startHoopsCameraRecordingAsync(muted = false): Promise<HoopsCameraRecording> {
  return requireHoopsCamera().startRecordingAsync(muted);
}

export function stopHoopsCameraRecordingAsync(): Promise<HoopsCameraRecording> {
  return requireHoopsCamera().stopRecordingAsync();
}

export function setHoopsCameraMicrophoneMutedAsync(muted: boolean): Promise<void> {
  return requireHoopsCamera().setMicrophoneMutedAsync(muted);
}

export function setHoopsCameraFacingAsync(facing: CameraFacing): Promise<void> {
  return requireHoopsCamera().setFacingAsync(facing);
}

export function setHoopsCameraZoomAsync(zoom: number): Promise<void> {
  if (!Number.isFinite(zoom) || zoom < 0 || zoom > 1) {
    return Promise.reject(new RangeError('HoopsCamera zoom must be between 0 and 1.'));
  }
  return requireHoopsCamera().setZoomAsync(zoom);
}

/**
 * Creates a WebRTC-compatible video track from HoopsCamera's capture session.
 * This does not call getUserMedia and therefore does not start a second camera
 * capturer. Frames are best-effort; recording keeps priority and late frames
 * are discarded natively.
 */
export async function createHoopsCameraLiveVideoAsync(): Promise<HoopsCameraLiveVideo> {
  const webRTCModule = getHoopsCameraWebRTCNativeModule();
  if (webRTCModule === null) {
    throw new Error(
      'HoopsCamera WebRTC integration is unavailable. Use an iOS development client with the patched react-native-webrtc module.',
    );
  }

  const info = webRTCModule.createHoopsCameraVideoStreamNative
    ? await webRTCModule.createHoopsCameraVideoStreamNative()
    : await webRTCModule.createHoopsCameraVideoStream();
  // Load lazily for the same feature-detection reason as above. The returned
  // object is the regular react-native-webrtc MediaStream class, so its track
  // can be passed directly to RTCPeerConnection.addTrack.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const webRTC = require('react-native-webrtc') as {
    MediaStream: new (info: {
      streamId: string;
      streamReactTag: string;
      tracks: HoopsCameraWebRTCNativeStreamInfo['track'][];
    }) => RTCMediaStream;
  };
  const stream = new webRTC.MediaStream({
    streamId: info.streamId,
    streamReactTag: info.streamId,
    tracks: [info.track],
  });
  const track = stream.getVideoTracks()[0];
  if (!track) {
    throw new Error('HoopsCamera WebRTC integration returned no video track.');
  }
  return { stream, track };
}

export async function releaseHoopsCameraLiveVideoAsync(): Promise<void> {
  const webRTCModule = getHoopsCameraWebRTCNativeModule();
  if (webRTCModule === null) {
    return;
  }
  if (webRTCModule.releaseHoopsCameraVideoStreamNative) {
    await webRTCModule.releaseHoopsCameraVideoStreamNative();
  } else {
    await webRTCModule.releaseHoopsCameraVideoStream();
  }
}

// Short aliases keep the facade pleasant to consume without exposing the
// native module object itself.
export const startRecordingAsync = startHoopsCameraRecordingAsync;
export const stopRecordingAsync = stopHoopsCameraRecordingAsync;
export const setMicrophoneMutedAsync = setHoopsCameraMicrophoneMutedAsync;
export const setFacingAsync = setHoopsCameraFacingAsync;
export const setZoomAsync = setHoopsCameraZoomAsync;
export const createLiveVideoAsync = createHoopsCameraLiveVideoAsync;