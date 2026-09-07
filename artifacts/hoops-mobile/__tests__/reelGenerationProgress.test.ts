import {
  getGenerationElapsedSec,
  resolveGenerationStartedAtMs,
} from '../lib/reelGenerationProgress';

describe('reel generation progress', () => {
  it('uses the persisted server timestamp after a screen remount', () => {
    const now = Date.parse('2026-09-07T00:18:23.000Z');
    const startedAt = '2026-09-07T00:16:43.000Z';

    const resolved = resolveGenerationStartedAtMs(startedAt, undefined, now);

    expect(getGenerationElapsedSec(resolved, now)).toBe(100);
  });

  it('keeps the existing local timestamp when a polling response omits startedAt', () => {
    const existing = Date.parse('2026-09-07T00:16:43.000Z');
    const now = Date.parse('2026-09-07T00:18:23.000Z');

    expect(resolveGenerationStartedAtMs(undefined, existing, now)).toBe(existing);
    expect(getGenerationElapsedSec(existing, now)).toBe(100);
  });

  it('clamps a server timestamp that is ahead of the device clock', () => {
    const now = Date.parse('2026-09-07T00:18:23.000Z');
    const future = '2026-09-07T00:18:30.000Z';

    expect(resolveGenerationStartedAtMs(future, undefined, now)).toBe(now);
  });
});