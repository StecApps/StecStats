import {
  createVideoTimelineClock,
  readVideoTimelineMs,
  startVideoTimelineSegment,
  stopVideoTimelineSegment,
} from '../lib/videoTimelineClock';

describe('video timeline clock', () => {
  test('counts only time represented by recorded segments', () => {
    const clock = createVideoTimelineClock();

    startVideoTimelineSegment(clock, 1_000);
    expect(readVideoTimelineMs(clock, 6_000)).toBe(5_000);
    stopVideoTimelineSegment(clock, 8_000);

    // Camera finalization/switch time is absent from the concatenated movie.
    expect(readVideoTimelineMs(clock, 20_000)).toBe(7_000);

    startVideoTimelineSegment(clock, 25_000);
    expect(readVideoTimelineMs(clock, 28_500)).toBe(10_500);
    stopVideoTimelineSegment(clock, 30_000);
    expect(readVideoTimelineMs(clock, 60_000)).toBe(12_000);
  });

  test('start and stop are idempotent for an active segment', () => {
    const clock = createVideoTimelineClock();
    startVideoTimelineSegment(clock, 100);
    startVideoTimelineSegment(clock, 500);
    stopVideoTimelineSegment(clock, 1_100);
    stopVideoTimelineSegment(clock, 2_000);

    expect(readVideoTimelineMs(clock, 5_000)).toBe(1_000);
  });
});