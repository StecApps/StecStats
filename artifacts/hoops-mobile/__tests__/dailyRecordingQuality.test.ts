import { cloudRecordingQualityForTrack, dailyLiveVideoOptions } from '../lib/dailyBroadcast';

describe('Daily cloud recording quality', () => {
  test('keeps the selected camera lens and requests a high-quality Live source', () => {
    expect(dailyLiveVideoOptions('back')).toEqual({
      inputSettings: { video: { settings: {
        facingMode: 'environment', width: 1920, height: 1080, frameRate: 30,
      } } },
      sendSettings: { video: 'quality-optimized' },
    });
    expect(dailyLiveVideoOptions('front').inputSettings.video.settings.facingMode).toBe('user');
  });

  test('requests 1080p only from a camera track that reports real 1080p frames', () => {
    expect(cloudRecordingQualityForTrack({
      getSettings: () => ({ width: 1920, height: 1080 }),
    })).toEqual({ width: 1920, height: 1080, videoBitrate: 4000 });
    expect(cloudRecordingQualityForTrack({
      getSettings: () => ({ width: 1080, height: 1920 }),
    })).toEqual({ width: 1920, height: 1080, videoBitrate: 4000 });
  });

  test('does not upscale a 720p or unmeasured camera source', () => {
    const standard = { width: 1280, height: 720 };
    expect(cloudRecordingQualityForTrack({
      getSettings: () => ({ width: 1280, height: 720 }),
    })).toEqual(standard);
    expect(cloudRecordingQualityForTrack(null)).toEqual(standard);
    expect(cloudRecordingQualityForTrack({
      getSettings: () => { throw new Error('unsupported'); },
    })).toEqual(standard);
  });
});