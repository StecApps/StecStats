import { readFileSync } from 'fs';
import { join } from 'path';

jest.mock('expo', () => ({
  requireOptionalNativeModule: () => null,
  requireNativeView: () => null,
}));

describe('HoopsCamera WebRTC integration contract', () => {
  it('feature-detects the bridge without requiring WebRTC in Expo Go', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const facade = require('../src') as typeof import('../src');

    expect(facade.isHoopsCameraWebRTCAvailable).toBe(false);
    return expect(facade.createHoopsCameraLiveVideoAsync()).rejects.toThrow(
      'HoopsCamera WebRTC integration is unavailable',
    );
  });

  it('keeps the capture and WebRTC boundaries explicit', () => {
    const iosDirectory = join(__dirname, '..', 'ios');
    const session = readFileSync(join(iosDirectory, 'HoopsCameraSession.swift'), 'utf8');
    const module = readFileSync(join(iosDirectory, 'HoopsCameraModule.swift'), 'utf8');
    const router = readFileSync(join(iosDirectory, 'HoopsCameraFrameRouter.swift'), 'utf8');
    const podspec = readFileSync(join(iosDirectory, 'HoopsCamera.podspec'), 'utf8');
    const patch = readFileSync(
      join(__dirname, '..', '..', '..', '..', '..', 'patches', 'react-native-webrtc@124.0.8.patch'),
      'utf8',
    );

    expect(session).toContain('HoopsCamera.videoSampleBuffer');
    expect(session).not.toContain('import WebRTC');
    expect(podspec).not.toContain("s.dependency 'JitsiWebRTC'");
    expect(podspec).not.toContain("s.dependency 'react-native-webrtc'");
    expect(router).toContain('DispatchSemaphore(value: 1)');
    expect(router).toContain('CMSampleBufferCreateCopy');
    expect(router).toContain('ownedSampleBuffer');
    expect(router).toContain('func setFrameSink');
    expect(session).toContain('frameRouter.setFrameSink(nil)');
    expect(session).toContain('videoDataOutput != nil');
    expect(session).toContain('alwaysDiscardsLateVideoFrames');
    expect(session).toContain('setMicrophoneMuted');
    expect(session).toContain('audioConnection.isEnabled = !microphoneMuted');
    expect(session).toContain('func startRecording(muted: Bool');
    expect(session).toContain('self.microphoneMuted = muted');
    expect(session).toContain('movieOutput.startRecording');
    expect(module).toContain('setMicrophoneMutedAsync');
    expect(module).toContain('(muted: Bool, promise: Promise)');
    expect(patch).toContain('self.localTracks[trackId] = videoTrack');
    expect(patch).toContain('RTCCVPixelBuffer');
    expect(patch).toContain('createHoopsCameraVideoStream');
    expect(patch).not.toContain('RTCCameraVideoCapturer alloc');
  });
});