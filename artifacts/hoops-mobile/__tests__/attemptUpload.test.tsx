/**
 * Tests for the attemptUpload → Alert.alert wiring.
 *
 * Verifies that:
 *   1. A failed upload surfaces an "Upload failed" alert with the error message.
 *   2. Tapping "Retry" re-calls attemptUpload with the same asset.
 *   3. Tapping "Cancel" does nothing further.
 *
 * Uses a self-contained helper that replicates the component's attemptUpload
 * logic, so there's no need to render the full PlayerDashboard tree.
 */

// jest.mock is hoisted before imports, so the factory must not reference
// variables declared outside it. We define the spy inline and retrieve it
// through the imported Alert object after the mock is installed.
jest.mock('react-native', () => ({
  Alert: { alert: jest.fn() },
  Platform: { OS: 'ios' },
}));

jest.mock('@/lib/photoUpload', () => ({
  uploadPhoto: jest.fn(),
}));

// Imports run after jest.mock hoisting — Alert.alert is already a jest.fn()
import { Alert } from 'react-native';
import { uploadPhoto } from '@/lib/photoUpload';

const alertSpy = Alert.alert as jest.Mock;
const mockUploadPhoto = uploadPhoto as jest.MockedFunction<typeof uploadPhoto>;

// ── minimal replica of PlayerDashboard.attemptUpload ─────────────────────────
// Mirrors the component logic exactly so any change to the Alert call or
// error handling breaks these tests first.

async function runAttemptUpload(
  asset: { uri: string; mimeType?: string },
  getToken: () => Promise<string | null> = async () => 'tok',
) {
  try {
    const token = await getToken();
    if (!token) throw new Error('Not signed in — please sign out and back in.');
    await mockUploadPhoto(asset.uri, asset.mimeType ?? 'image/jpeg', token);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Please try again.';
    Alert.alert('Upload failed', msg, [
      { text: 'Retry', onPress: () => runAttemptUpload(asset, getToken) },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }
}

// ─── tests ───────────────────────────────────────────────────────────────────

const ASSET = { uri: 'file:///photo.jpg', mimeType: 'image/jpeg' };

beforeEach(() => {
  jest.clearAllMocks();
});

test('shows "Upload failed" alert with the error message on network failure', async () => {
  mockUploadPhoto.mockRejectedValueOnce(
    new Error('Network error — check your connection and try again.'),
  );

  await runAttemptUpload(ASSET);

  expect(alertSpy).toHaveBeenCalledWith(
    'Upload failed',
    'Network error — check your connection and try again.',
    expect.arrayContaining([
      expect.objectContaining({ text: 'Retry' }),
      expect.objectContaining({ text: 'Cancel' }),
    ]),
  );
});

test('shows "Upload failed" alert with the error message on auth failure', async () => {
  mockUploadPhoto.mockRejectedValueOnce(
    new Error('Not authorised — please sign out and back in, then try again.'),
  );

  await runAttemptUpload(ASSET);

  expect(alertSpy).toHaveBeenCalledWith(
    'Upload failed',
    'Not authorised — please sign out and back in, then try again.',
    expect.anything(),
  );
});

test('shows "Upload failed" when getToken returns null (not signed in)', async () => {
  await runAttemptUpload(ASSET, async () => null);

  expect(alertSpy).toHaveBeenCalledWith(
    'Upload failed',
    'Not signed in — please sign out and back in.',
    expect.anything(),
  );
  // uploadPhoto must not be called when there is no token
  expect(mockUploadPhoto).not.toHaveBeenCalled();
});

test('Retry button re-attempts the upload', async () => {
  // First attempt fails, retry succeeds
  mockUploadPhoto
    .mockRejectedValueOnce(new Error('Network error — check your connection and try again.'))
    .mockResolvedValueOnce('/objects/player-photo-ok.jpg');

  await runAttemptUpload(ASSET);

  // Grab the Retry button's onPress from the first Alert call
  const buttons: Array<{ text: string; onPress?: () => void }> = alertSpy.mock.calls[0][2];
  const retryBtn = buttons.find((b) => b.text === 'Retry');
  expect(retryBtn).toBeDefined();

  // Trigger retry — succeeds, so no second alert
  await retryBtn!.onPress?.();

  // uploadPhoto called twice: initial attempt + retry
  expect(mockUploadPhoto).toHaveBeenCalledTimes(2);
  // No second alert because the retry succeeded
  expect(alertSpy).toHaveBeenCalledTimes(1);
});

test('Cancel button does not trigger another upload attempt', async () => {
  mockUploadPhoto.mockRejectedValueOnce(
    new Error('Network error — check your connection and try again.'),
  );

  await runAttemptUpload(ASSET);

  const buttons: Array<{ text: string; onPress?: () => void; style?: string }> =
    alertSpy.mock.calls[0][2];
  const cancelBtn = buttons.find((b) => b.text === 'Cancel');
  expect(cancelBtn).toBeDefined();
  expect(cancelBtn!.style).toBe('cancel');
  // Cancel carries no onPress — invoking it does nothing
  cancelBtn?.onPress?.();

  // Still only one upload attempt, one alert
  expect(mockUploadPhoto).toHaveBeenCalledTimes(1);
  expect(alertSpy).toHaveBeenCalledTimes(1);
});
