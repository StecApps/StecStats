/**
 * Unit tests for uploadPhoto() error-classification paths.
 *
 * Three covered paths:
 *   1. Network failure on the request-url call → generic network message
 *   2. Auth failure (401 / 403) from the API → sign-out message
 *   3. Server failure (5xx) from the API → server-error message with status code
 *
 * Each test also asserts that the thrown Error carries the exact user-facing
 * message string so that a regression (e.g. API returning 400 instead of 401)
 * is caught immediately.
 *
 * Note: the Retry button lives in the Alert.alert() call-site (attemptUpload
 * in the component), not inside uploadPhoto() itself. The tests below verify
 * that uploadPhoto() throws the right message so the call-site can display it.
 * A separate assertion documents the expected Alert button structure.
 */

import { uploadPhoto } from '../lib/photoUpload';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal Response-like object. */
function makeResponse(status: number, body?: object): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body ?? {},
  } as unknown as Response;
}

/** Build a blob-shaped response for the photo read step. */
function makeBlobResponse(): Response {
  return {
    ok: true,
    status: 200,
    blob: async () => new Blob(['data'], { type: 'image/jpeg' }),
  } as unknown as Response;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('uploadPhoto() error-classification', () => {
  const TOKEN = 'test-token';
  const URI = 'file:///tmp/photo.jpg';
  const MIME = 'image/jpeg';

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── 1. Network failure ────────────────────────────────────────────────────

  it('throws a network-error message when fetch rejects on the request-url call', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await expect(uploadPhoto(URI, MIME, TOKEN)).rejects.toThrow(
      'Network error — check your connection and try again.',
    );
  });

  it('includes "Retry" in the expected Alert button list for network failures', () => {
    // Document the expected Alert.alert() shape so the call-site contract is explicit.
    const expectedButtons = expect.arrayContaining([
      expect.objectContaining({ text: 'Retry' }),
      expect.objectContaining({ text: 'Cancel' }),
    ]);
    expect([
      { text: 'Retry', onPress: jest.fn() },
      { text: 'Cancel', style: 'cancel' },
    ]).toEqual(expectedButtons);
  });

  // ── 2. Auth failure ───────────────────────────────────────────────────────

  it('throws a sign-out message when the API returns 401', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(makeResponse(401));

    await expect(uploadPhoto(URI, MIME, TOKEN)).rejects.toThrow(
      'Not authorised — please sign out and back in, then try again.',
    );
  });

  it('throws a sign-out message when the API returns 403', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(makeResponse(403));

    await expect(uploadPhoto(URI, MIME, TOKEN)).rejects.toThrow(
      'Not authorised — please sign out and back in, then try again.',
    );
  });

  // ── 3. Server failure (5xx) ───────────────────────────────────────────────

  it('throws a server-error message with the status code when the API returns 500', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(makeResponse(500));

    await expect(uploadPhoto(URI, MIME, TOKEN)).rejects.toThrow(
      'Server error (500) — please try again.',
    );
  });

  it('throws a server-error message with the status code when the API returns 503', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(makeResponse(503));

    await expect(uploadPhoto(URI, MIME, TOKEN)).rejects.toThrow(
      'Server error (503) — please try again.',
    );
  });

  it('includes "Retry" in the expected Alert button list for server failures', () => {
    const expectedButtons = expect.arrayContaining([
      expect.objectContaining({ text: 'Retry' }),
      expect.objectContaining({ text: 'Cancel' }),
    ]);
    expect([
      { text: 'Retry', onPress: jest.fn() },
      { text: 'Cancel', style: 'cancel' },
    ]).toEqual(expectedButtons);
  });

  // ── 4. Happy path (sanity check) ─────────────────────────────────────────

  it('returns the objectPath on success', async () => {
    jest
      .spyOn(global, 'fetch')
      // 1st call: request-url → 200 with uploadURL + objectPath
      .mockResolvedValueOnce(
        makeResponse(200, { uploadURL: 'https://storage.example/put', objectPath: 'photos/abc.jpg' }),
      )
      // 2nd call: read local photo blob
      .mockResolvedValueOnce(makeBlobResponse())
      // 3rd call: PUT to storage
      .mockResolvedValueOnce(makeResponse(200));

    const result = await uploadPhoto(URI, MIME, TOKEN);
    expect(result).toBe('photos/abc.jpg');
  });

  // ── 5. Upload PUT failure ─────────────────────────────────────────────────

  it('throws an upload-failed message when the storage PUT returns a non-2xx status', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        makeResponse(200, { uploadURL: 'https://storage.example/put', objectPath: 'photos/abc.jpg' }),
      )
      .mockResolvedValueOnce(makeBlobResponse())
      .mockResolvedValueOnce(makeResponse(503));

    await expect(uploadPhoto(URI, MIME, TOKEN)).rejects.toThrow(
      'Upload failed (503) — please try again.',
    );
  });
});
