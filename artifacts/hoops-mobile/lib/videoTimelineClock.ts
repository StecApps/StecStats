export type VideoTimelineClock = {
  accumulatedMs: number;
  segmentStartedAtMs: number | null;
};

export function createVideoTimelineClock(): VideoTimelineClock {
  return { accumulatedMs: 0, segmentStartedAtMs: null };
}

export function startVideoTimelineSegment(clock: VideoTimelineClock, nowMs = Date.now()): void {
  if (clock.segmentStartedAtMs === null) {
    clock.segmentStartedAtMs = nowMs;
  }
}

export function stopVideoTimelineSegment(clock: VideoTimelineClock, nowMs = Date.now()): void {
  if (clock.segmentStartedAtMs === null) return;
  clock.accumulatedMs += Math.max(0, nowMs - clock.segmentStartedAtMs);
  clock.segmentStartedAtMs = null;
}

export function readVideoTimelineMs(clock: VideoTimelineClock, nowMs = Date.now()): number {
  if (clock.segmentStartedAtMs === null) return clock.accumulatedMs;
  return clock.accumulatedMs + Math.max(0, nowMs - clock.segmentStartedAtMs);
}