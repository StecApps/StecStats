/**
 * Tests for uploadVideoFile — simulated progress bar on slow / suppressed XHR.
 *
 * The upload function runs a 300 ms asymptotic ticker (→ 90 %) so that the
 * progress bar always advances even on iOS WebKit, which can suppress or fire
 * xhr.upload.onprogress only once.  These tests verify:
 *
 *   1. At least one intermediate value (10–89 %) is reported before 100 %
 *      when the XHR never fires onprogress (iOS-suppressed case).
 *   2. Real XHR progress events win over the simulated values when they are
 *      higher.
 *   3. The final value reported is always 100 % on success.
 *   4. The simulated ticker is cleared when the upload completes (no further
 *      callbacks after 100 %).
 */

import { uploadVideoFile } from '@/lib/uploadVideoFile';

// ─── XHR fake ────────────────────────────────────────────────────────────────

/**
 * A minimal XMLHttpRequest stand-in whose send() resolves after `delayMs`
 * without ever firing upload.onprogress — mirroring iOS WebKit suppression.
 * Callers can advance Jest fake timers to trigger the simulated ticker, then
 * call complete() to settle the XHR.
 */
class FakeXHR {
  status = 200;
  upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;

  private _completeResolve: (() => void) | null = null;

  open(_method: string, _url: string) {}
  setRequestHeader(_name: string, _value: string) {}
  send(_body: unknown) {
    // Don't settle immediately — the test drives completion via complete().
  }
  abort() {
    this.onabort?.();
  }

  /** Call from tests to simulate a successful response arriving. */
  complete() {
    this.onload?.();
  }

  /** Call from tests to simulate a network error. */
  fail() {
    this.onerror?.();
  }

  /** Fire a real upload progress event with given loaded/total bytes. */
  fireProgress(loaded: number, total: number) {
    this.upload.onprogress?.({
      lengthComputable: true,
      loaded,
      total,
    } as ProgressEvent);
  }
}

// ─── Global stubs ─────────────────────────────────────────────────────────────

let currentXhr: FakeXHR;

beforeEach(() => {
  jest.useFakeTimers();

  // A fresh FakeXHR is created for each test; captured so tests can drive it.
  currentXhr = new FakeXHR();
  (global as any).XMLHttpRequest = jest.fn(() => currentXhr);

  // fetch() returns a Blob-like object; size is non-zero so the presign call
  // receives a realistic byte count.
  (global as any).fetch = jest.fn().mockResolvedValue({
    blob: () => Promise.resolve({ size: 500_000_000, type: 'video/mp4' }),
  });
});

afterEach(() => {
  jest.useRealTimers();
  delete (global as any).XMLHttpRequest;
  delete (global as any).fetch;
});

// ─── Helper ───────────────────────────────────────────────────────────────────

/** A minimal requestUploadUrl implementation that returns a dummy URL/path. */
const fakeRequestUploadUrl = jest.fn().mockResolvedValue({
  uploadURL: 'https://storage.example.com/put-here',
  objectPath: 'recordings/game-123.mp4',
});

// ─── Tests ────────────────────────────────────────────────────────────────────

test('simulated ticker reports at least one intermediate value (10–89 %) when XHR never fires onprogress', async () => {
  const reported: number[] = [];

  // Start the upload — it will await the XHR promise.
  const uploadPromise = uploadVideoFile(
    'file:///game.mp4',
    fakeRequestUploadUrl,
    (pct) => reported.push(pct),
  );

  // Allow fetch + presign to settle before timers run.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  // Advance 5 ticks (1 500 ms) — enough for the asymptotic curve to move well
  // above 10 %.  The ticker fires every 300 ms.
  jest.advanceTimersByTime(1_500);

  // Now complete the XHR so the promise resolves.
  currentXhr.complete();

  await uploadPromise;

  // Must have at least one intermediate value strictly between 10 and 89.
  const intermediate = reported.filter((p) => p >= 10 && p <= 89);
  expect(intermediate.length).toBeGreaterThanOrEqual(1);

  // Final value must be 100.
  expect(reported[reported.length - 1]).toBe(100);
});

test('progress starts from 0 and never exceeds 100 before completion', async () => {
  const reported: number[] = [];

  const uploadPromise = uploadVideoFile(
    'file:///game.mp4',
    fakeRequestUploadUrl,
    (pct) => reported.push(pct),
  );

  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  jest.advanceTimersByTime(3_000); // 10 ticks

  currentXhr.complete();
  await uploadPromise;

  // Every value must be in [0, 100].
  expect(reported.every((p) => p >= 0 && p <= 100)).toBe(true);
  expect(reported[reported.length - 1]).toBe(100);
});

test('real XHR onprogress events override the simulated values when higher', async () => {
  const reported: number[] = [];

  const uploadPromise = uploadVideoFile(
    'file:///game.mp4',
    fakeRequestUploadUrl,
    (pct) => reported.push(pct),
  );

  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  // Fire one simulated tick (8 % of 90 = ~8).
  jest.advanceTimersByTime(300);

  // Now fire a real progress event at 60 % — must appear in reported values.
  currentXhr.fireProgress(300_000_000, 500_000_000); // 60 %

  // One more simulated tick — should NOT report anything because 60 % > CAP
  // wait, CAP is 90, so the ticker would still advance from 60 toward 90.
  // But the real value (60) was already set as reportedPct, so the ticker
  // only emits values > 60 on subsequent ticks.
  jest.advanceTimersByTime(300);

  currentXhr.complete();
  await uploadPromise;

  // The real 60 % event must appear in the sequence.
  expect(reported).toContain(60);

  // Values must be monotonically non-decreasing (each tick only reports if higher).
  for (let i = 1; i < reported.length; i++) {
    expect(reported[i]).toBeGreaterThanOrEqual(reported[i - 1]);
  }

  expect(reported[reported.length - 1]).toBe(100);
});

test('simulated ticker is cleared after completion — no callbacks fire after 100 %', async () => {
  const reported: number[] = [];

  const uploadPromise = uploadVideoFile(
    'file:///game.mp4',
    fakeRequestUploadUrl,
    (pct) => reported.push(pct),
  );

  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  jest.advanceTimersByTime(600); // 2 ticks before completing

  currentXhr.complete();
  await uploadPromise;

  const countAtCompletion = reported.length;
  expect(reported[countAtCompletion - 1]).toBe(100);

  // Advance timers further — the cleared interval must not fire any more callbacks.
  jest.advanceTimersByTime(3_000);
  expect(reported.length).toBe(countAtCompletion);
});

test('the simulated ticker reaches an observable intermediate value within 300 ms', async () => {
  // This pins the TICK_MS=300 and CAP=90 constants: the very first tick must
  // produce a value > 0 (the asymptotic formula is ceil(90 * 0.08) = 8).
  const reported: number[] = [];

  const uploadPromise = uploadVideoFile(
    'file:///game.mp4',
    fakeRequestUploadUrl,
    (pct) => reported.push(pct),
  );

  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  // Exactly one tick.
  jest.advanceTimersByTime(300);

  currentXhr.complete();
  await uploadPromise;

  // First intermediate value must be > 0.
  const firstIntermediate = reported.find((p) => p < 100);
  expect(firstIntermediate).toBeDefined();
  expect(firstIntermediate!).toBeGreaterThan(0);
});

test('returns the objectPath on successful upload', async () => {
  const uploadPromise = uploadVideoFile(
    'file:///game.mp4',
    fakeRequestUploadUrl,
    () => {},
  );

  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  currentXhr.complete();
  const result = await uploadPromise;

  expect(result).toBe('recordings/game-123.mp4');
});
