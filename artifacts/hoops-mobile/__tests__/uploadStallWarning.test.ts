/**
 * Tests for the upload stall warning — exercising the production
 * makeUploadStallHandler helper extracted from scorekeeper.tsx.
 *
 * The stall watchdog in uploadVideoFile fires onStall after UPLOAD_STALL_MS
 * (~45 s) of no real XHR byte progress.  makeUploadStallHandler builds the
 * callback that scorekeeper.tsx passes as onStall; it:
 *
 *   • Shows an Alert("Upload seems stuck", …) with three buttons.
 *   • Guards against duplicate alerts via stallAlertActiveRef.
 *   • "Keep waiting"       → clears the guard so a future stall can reopen it.
 *   • "Save without video" → aborts the XHR, clears upload state, and calls
 *                            doSaveGame(null) for a stats-only save.
 *   • "Cancel upload"      → delegates to handleCancelUpload.
 *
 * Watchdog integration tests drive uploadVideoFile with fake timers so the
 * 45-second threshold is crossed in-process, confirming end-to-end wiring.
 */

jest.mock('react-native', () => ({
  Alert: { alert: jest.fn() },
  Platform: { OS: 'ios' },
}));

import { Alert } from 'react-native';
import { makeUploadStallHandler } from '@/lib/uploadStallAlert';
import { uploadVideoFile, UPLOAD_STALL_MS } from '@/lib/uploadVideoFile';

const alertSpy = Alert.alert as jest.Mock;

// ─── FakeXHR ─────────────────────────────────────────────────────────────────

class FakeXHR {
  status = 200;
  upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;

  open(_method: string, _url: string) {}
  setRequestHeader(_name: string, _value: string) {}
  send(_body: unknown) {}

  abort() { this.onabort?.(); }
  complete() { this.onload?.(); }
  fireProgress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total } as ProgressEvent);
  }
}

let currentXhr: FakeXHR;

const fakeRequestUploadUrl = jest.fn().mockResolvedValue({
  uploadURL: 'https://storage.example.com/put-here',
  objectPath: 'recordings/game-123.mp4',
});

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();

  currentXhr = new FakeXHR();
  (global as any).XMLHttpRequest = jest.fn(() => currentXhr);

  (global as any).fetch = jest.fn().mockResolvedValue({
    blob: () => Promise.resolve({ size: 500_000_000, type: 'video/mp4' }),
  });
});

afterEach(() => {
  jest.useRealTimers();
  delete (global as any).XMLHttpRequest;
  delete (global as any).fetch;
});

// ─── Helper: build realistic deps matching scorekeeper.tsx wiring ──────────

function makeDeps() {
  const stallAlertActiveRef = { current: false };
  const stallFiredOnceRef = { current: false };
  const attemptToken = { cancelled: false };
  const uploadXhrRef: { current: XMLHttpRequest | null } = { current: currentXhr as unknown as XMLHttpRequest };

  let uploadProgress: number | null = 0;
  const setUploadProgress = jest.fn((v: number | null) => { uploadProgress = v; });

  let saving = true;
  const setSaving = jest.fn((v: boolean) => { saving = v; });

  const doSaveGame = jest.fn();
  const handleCancelUpload = jest.fn();

  return {
    stallAlertActiveRef,
    stallFiredOnceRef,
    attemptToken,
    uploadXhrRef,
    setUploadProgress,
    setSaving,
    doSaveGame,
    handleCancelUpload,
    getUploadProgress: () => uploadProgress,
    getSaving: () => saving,
  };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// ─── Alert shape / button tests ───────────────────────────────────────────────

test('shows "Upload seems stuck" alert with all three buttons', () => {
  const deps = makeDeps();
  const onUploadStall = makeUploadStallHandler(deps);

  onUploadStall();

  expect(alertSpy).toHaveBeenCalledTimes(1);
  const [title, message, buttons] = alertSpy.mock.calls[0];
  expect(title).toBe('Upload seems stuck');
  expect(message).toMatch(/slow or interrupted/i);
  expect(buttons).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ text: 'Keep waiting' }),
      expect.objectContaining({ text: 'Save without video' }),
      expect.objectContaining({ text: 'Cancel upload' }),
    ]),
  );
});

test('"Keep waiting" clears stallAlertActiveRef and latches stallFiredOnceRef', () => {
  const deps = makeDeps();
  const onUploadStall = makeUploadStallHandler(deps);

  onUploadStall();
  expect(alertSpy).toHaveBeenCalledTimes(1);
  expect(deps.stallAlertActiveRef.current).toBe(true);

  const buttons: Array<{ text: string; onPress?: () => void }> = alertSpy.mock.calls[0][2];
  buttons.find((b) => b.text === 'Keep waiting')?.onPress?.();

  // Re-entry guard cleared; fired-once latch set.
  expect(deps.stallAlertActiveRef.current).toBe(false);
  expect(deps.stallFiredOnceRef.current).toBe(true);

  // A subsequent stall must NOT open another alert — coach already dismissed one.
  onUploadStall();
  expect(alertSpy).toHaveBeenCalledTimes(1);
});

test('stallFiredOnceRef blocks a second alert even when stallAlertActiveRef was cleared', () => {
  const deps = makeDeps();
  // Simulate: coach already tapped "Keep waiting" on a prior stall.
  deps.stallFiredOnceRef.current = true;
  const onUploadStall = makeUploadStallHandler(deps);

  onUploadStall();

  expect(alertSpy).not.toHaveBeenCalled();
});

test('"Save without video" aborts the XHR, clears state, and calls doSaveGame(null)', () => {
  const deps = makeDeps();
  const abortSpy = jest.spyOn(currentXhr, 'abort');
  const onUploadStall = makeUploadStallHandler(deps);

  onUploadStall();

  const buttons: Array<{ text: string; onPress?: () => void }> = alertSpy.mock.calls[0][2];
  buttons.find((b) => b.text === 'Save without video')?.onPress?.();

  expect(abortSpy).toHaveBeenCalledTimes(1);
  expect(deps.uploadXhrRef.current).toBeNull();
  expect(deps.attemptToken.cancelled).toBe(true);
  expect(deps.setUploadProgress).toHaveBeenCalledWith(null);
  expect(deps.setSaving).toHaveBeenCalledWith(false);
  expect(deps.doSaveGame).toHaveBeenCalledWith(null);
  expect(deps.stallAlertActiveRef.current).toBe(false);
});

test('"Cancel upload" calls handleCancelUpload and clears the guard', () => {
  const deps = makeDeps();
  const onUploadStall = makeUploadStallHandler(deps);

  onUploadStall();

  const buttons: Array<{ text: string; onPress?: () => void }> = alertSpy.mock.calls[0][2];
  buttons.find((b) => b.text === 'Cancel upload')?.onPress?.();

  expect(deps.handleCancelUpload).toHaveBeenCalledTimes(1);
  expect(deps.stallAlertActiveRef.current).toBe(false);
});

test('guard blocks a second stall alert while the first is still visible', () => {
  const deps = makeDeps();
  const onUploadStall = makeUploadStallHandler(deps);

  onUploadStall();
  onUploadStall(); // before any button is tapped

  expect(alertSpy).toHaveBeenCalledTimes(1);
});

test('guard blocks the alert when the upload was already cancelled', () => {
  const deps = makeDeps();
  deps.attemptToken.cancelled = true;
  const onUploadStall = makeUploadStallHandler(deps);

  onUploadStall();

  expect(alertSpy).not.toHaveBeenCalled();
});

// ─── Watchdog integration tests (uploadVideoFile + makeUploadStallHandler) ───

test('alert appears within UPLOAD_STALL_MS when the XHR never fires onprogress', async () => {
  const deps = makeDeps();
  const onUploadStall = makeUploadStallHandler(deps);

  const uploadPromise = uploadVideoFile(
    'file:///game.mp4',
    fakeRequestUploadUrl,
    undefined,
    undefined,
    undefined,
    onUploadStall,
  );

  await flushPromises();

  // Just under the threshold — no alert yet.
  jest.advanceTimersByTime(UPLOAD_STALL_MS - 1);
  expect(alertSpy).not.toHaveBeenCalled();

  // Cross the threshold — alert fires.
  jest.advanceTimersByTime(2);
  expect(alertSpy).toHaveBeenCalledTimes(1);
  expect(alertSpy.mock.calls[0][0]).toBe('Upload seems stuck');

  currentXhr.complete();
  await uploadPromise;
});

test('alert does NOT appear when the upload finishes normally before 45 s', async () => {
  const deps = makeDeps();
  const onUploadStall = makeUploadStallHandler(deps);

  const uploadPromise = uploadVideoFile(
    'file:///game.mp4',
    fakeRequestUploadUrl,
    undefined,
    undefined,
    undefined,
    onUploadStall,
  );

  await flushPromises();

  jest.advanceTimersByTime(20_000);
  currentXhr.complete();
  await uploadPromise;

  // Advance past the threshold after completion — watchdog must be cleared.
  jest.advanceTimersByTime(UPLOAD_STALL_MS);
  expect(alertSpy).not.toHaveBeenCalled();
});

test('watchdog resets on real XHR byte progress and does not fire within the stall window', async () => {
  const deps = makeDeps();
  const onUploadStall = makeUploadStallHandler(deps);

  const uploadPromise = uploadVideoFile(
    'file:///game.mp4',
    fakeRequestUploadUrl,
    () => {},
    undefined,
    undefined,
    onUploadStall,
  );

  await flushPromises();

  const TOTAL = 500_000_000;
  for (let i = 1; i <= 5; i++) {
    jest.advanceTimersByTime(10_000 - 1);
    currentXhr.fireProgress(i * 50_000_000, TOTAL);
  }

  expect(alertSpy).not.toHaveBeenCalled();

  currentXhr.complete();
  await uploadPromise;
});

test('watchdog fires ~45 s after the last real progress event, not the upload start', async () => {
  const deps = makeDeps();
  const onUploadStall = makeUploadStallHandler(deps);

  const uploadPromise = uploadVideoFile(
    'file:///game.mp4',
    fakeRequestUploadUrl,
    undefined,
    undefined,
    undefined,
    onUploadStall,
  );

  await flushPromises();

  // Advance 30 s then fire a real progress event to reset the watchdog.
  jest.advanceTimersByTime(30_000);
  currentXhr.fireProgress(100_000_000, 500_000_000);

  // 44 s after the reset — alert must not have fired yet.
  jest.advanceTimersByTime(UPLOAD_STALL_MS - 1);
  expect(alertSpy).not.toHaveBeenCalled();

  // Cross the 45-s threshold from the last event — alert fires.
  jest.advanceTimersByTime(2);
  expect(alertSpy).toHaveBeenCalledTimes(1);

  currentXhr.complete();
  await uploadPromise;
});

// ─── Two-clip sequential upload (camera-flip scenario) ───────────────────────
//
// scorekeeper.tsx uploads two clips in a for-loop sharing the same onUploadStall
// callback.  This test confirms that when clip 1 succeeds normally the watchdog
// arms again for clip 2, fires exactly once when clip 2 stalls, and that
// tapping "Keep waiting" correctly clears the re-entry guard.

test('stall alert fires on clip 2 when clip 1 uploaded successfully within 45 s', async () => {
  // Supply two separate FakeXHR instances — one per sequential uploadVideoFile call.
  const xhr1 = new FakeXHR();
  const xhr2 = new FakeXHR();
  const xhrs = [xhr1, xhr2];
  let xhrCallCount = 0;
  (global as any).XMLHttpRequest = jest.fn(() => xhrs[xhrCallCount++]);

  const deps = makeDeps();
  const onUploadStall = makeUploadStallHandler(deps);

  // ── Clip 1: completes quickly, no stall alert ─────────────────────────────
  const clip1Promise = uploadVideoFile(
    'file:///clip1.mp4',
    fakeRequestUploadUrl,
    undefined,
    undefined,
    undefined,
    onUploadStall,
  );
  await flushPromises();

  // 20 s — well under the 45-s threshold.
  jest.advanceTimersByTime(20_000);
  xhr1.complete();
  await clip1Promise;

  expect(alertSpy).not.toHaveBeenCalled();
  // Both guards must still be clear so clip 2 can raise the alert.
  expect(deps.stallAlertActiveRef.current).toBe(false);
  expect(deps.stallFiredOnceRef.current).toBe(false);

  // ── Clip 2: stalls past UPLOAD_STALL_MS ──────────────────────────────────
  const clip2Promise = uploadVideoFile(
    'file:///clip2.mp4',
    fakeRequestUploadUrl,
    undefined,
    undefined,
    undefined,
    onUploadStall,
  );
  await flushPromises();

  // Just under the threshold — no alert yet.
  jest.advanceTimersByTime(UPLOAD_STALL_MS - 1);
  expect(alertSpy).not.toHaveBeenCalled();

  // Cross the threshold — alert fires exactly once.
  jest.advanceTimersByTime(2);
  expect(alertSpy).toHaveBeenCalledTimes(1);
  expect(alertSpy.mock.calls[0][0]).toBe('Upload seems stuck');

  // "Keep waiting" must clear the re-entry guard so a future stall (if any)
  // won't erroneously be suppressed within this clip.
  const buttons: Array<{ text: string; onPress?: () => void }> = alertSpy.mock.calls[0][2];
  buttons.find((b) => b.text === 'Keep waiting')?.onPress?.();
  expect(deps.stallAlertActiveRef.current).toBe(false);
  // Fired-once latch is now set — a duplicate watchdog call is silently swallowed.
  expect(deps.stallFiredOnceRef.current).toBe(true);

  // Let clip 2 finish normally after the coach chose to keep waiting.
  xhr2.complete();
  await clip2Promise;
});
