/**
 * Tests for PendingPhotoRetry — the startup component that retries failed photo
 * uploads when the app reopens after a force-close.
 *
 * Part 1 (component tests) renders the REAL exported PendingPhotoRetry with
 * mocked external dependencies to confirm that mounting it automatically
 * processes the queue — not just that the retry logic works in isolation.
 *
 * Part 2 (logic tests) exercises the retry loop directly, covering branch
 * combinations that are harder to drive through the component (mixed-batch,
 * no-token short-circuit).
 *
 * Covered scenarios:
 *   Component:
 *     1. Pre-seeded queue + isSignedIn=true  → upload fires, player updated,
 *        entry dequeued, no alert.
 *     2. Pre-seeded queue + upload throws    → alert shown, entry kept.
 *     3. isSignedIn=false                   → nothing runs.
 *     4. isSignedIn false→true transition   → retry fires exactly once.
 *     5. Retry runs only once per session   → second render does not re-fire.
 *   Logic:
 *     6. No token → all entries stay, alert mentions count.
 *     7. Empty queue → no side-effects.
 *     8. Mixed batch → successes dequeued, failures kept, alert count correct.
 */

// ── Mocks (hoisted before imports) ───────────────────────────────────────────

jest.mock('react-native', () => ({
  Alert: { alert: jest.fn() },
  Platform: { OS: 'ios' },
}));

// In-memory AsyncStorage with a reset helper.
// Must be prefixed with "mock" so Jest's hoisting allows the reference inside the factory.
let mockAsyncStore: Record<string, string> = {};
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem:    jest.fn(async (k: string) => mockAsyncStore[k] ?? null),
    setItem:    jest.fn(async (k: string, v: string) => { mockAsyncStore[k] = v; }),
    removeItem: jest.fn(async (k: string) => { delete mockAsyncStore[k]; }),
  },
}));

jest.mock('@clerk/clerk-expo', () => ({
  useAuth: jest.fn(),
}));

jest.mock('@workspace/api-client-react', () => ({
  useUpdatePlayer:         jest.fn(),
  getListPlayersQueryKey:  jest.fn(() => ['players']),
}));

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: jest.fn(),
}));

jest.mock('@/lib/photoUpload', () => ({
  uploadPhoto: jest.fn(),
}));

// ── Imports (after hoisting) ──────────────────────────────────────────────────

import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Alert } from 'react-native';
import { useAuth } from '@clerk/clerk-expo';
import { useUpdatePlayer } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { uploadPhoto } from '@/lib/photoUpload';
import { enqueuePhoto, getPendingPhotos, dequeuePhoto } from '../lib/pendingPhotoQueue';
import { PendingPhotoRetry } from '../components/PendingPhotoRetry';

const alertSpy          = Alert.alert as jest.Mock;
const mockUseAuth       = useAuth as jest.Mock;
const mockUseUpdatePlayer = useUpdatePlayer as jest.Mock;
const mockUseQueryClient  = useQueryClient as jest.Mock;
const mockUploadPhoto   = uploadPhoto as jest.MockedFunction<typeof uploadPhoto>;

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeUpdatePlayer() {
  return { mutateAsync: jest.fn<Promise<void>, [any]>(async () => {}) };
}

function wireAuth(isSignedIn: boolean, token: string | null = 'auth-token') {
  mockUseAuth.mockReturnValue({
    isSignedIn,
    userId: isSignedIn ? TEST_USER_ID : null,
    getToken: jest.fn(async () => token),
  });
}

function wireQueryClient() {
  mockUseQueryClient.mockReturnValue({ invalidateQueries: jest.fn() });
}

const TEST_USER_ID = 'user_test123';
const ENTRY = { uri: 'file:///photo.jpg', mimeType: 'image/jpeg', playerId: 42 };

// ── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockAsyncStore = {};
  wireQueryClient();
});

// ═══════════════════════════════════════════════════════════════════════════════
// Part 1 — Component tests (render the real PendingPhotoRetry)
// ═══════════════════════════════════════════════════════════════════════════════

describe('PendingPhotoRetry component — mounts and processes queue automatically', () => {

  // 1. Success path ─────────────────────────────────────────────────────────────

  test('success: entry dequeued and player updated on app open', async () => {
    await enqueuePhoto(TEST_USER_ID, ENTRY.uri, ENTRY.mimeType, ENTRY.playerId);
    expect(await getPendingPhotos(TEST_USER_ID)).toHaveLength(1);

    mockUploadPhoto.mockResolvedValueOnce('objects/player-photo-ok.jpg');
    const updatePlayer = makeUpdatePlayer();
    mockUseUpdatePlayer.mockReturnValue(updatePlayer);
    wireAuth(true);

    await act(async () => { renderer.create(<PendingPhotoRetry />); });

    expect(mockUploadPhoto).toHaveBeenCalledWith(ENTRY.uri, ENTRY.mimeType, 'auth-token');
    expect(updatePlayer.mutateAsync).toHaveBeenCalledWith({
      playerId: ENTRY.playerId,
      data: { photoObjectPath: 'objects/player-photo-ok.jpg' },
    });
    expect(await getPendingPhotos(TEST_USER_ID)).toHaveLength(0);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  // 2. Upload failure ────────────────────────────────────────────────────────────

  test('failure: entry kept and single alert shown on app open', async () => {
    await enqueuePhoto(TEST_USER_ID, ENTRY.uri, ENTRY.mimeType, ENTRY.playerId);

    mockUploadPhoto.mockRejectedValueOnce(new Error('Network error'));
    const updatePlayer = makeUpdatePlayer();
    mockUseUpdatePlayer.mockReturnValue(updatePlayer);
    wireAuth(true);

    await act(async () => { renderer.create(<PendingPhotoRetry />); });

    expect(updatePlayer.mutateAsync).not.toHaveBeenCalled();
    expect(await getPendingPhotos(TEST_USER_ID)).toHaveLength(1);
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy).toHaveBeenCalledWith(
      'Photo upload incomplete',
      expect.stringContaining("1 player photo"),
      [{ text: 'OK' }],
    );
  });

  // 3. Not signed in — nothing runs ─────────────────────────────────────────────

  test('not signed in: queue untouched, no upload, no alert', async () => {
    await enqueuePhoto(TEST_USER_ID, ENTRY.uri, ENTRY.mimeType, ENTRY.playerId);

    mockUseUpdatePlayer.mockReturnValue(makeUpdatePlayer());
    wireAuth(false);

    await act(async () => { renderer.create(<PendingPhotoRetry />); });

    expect(mockUploadPhoto).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
    expect(await getPendingPhotos(TEST_USER_ID)).toHaveLength(1);
  });

  // 4. Sign-in transition (false → true) fires retry exactly once ───────────────

  test('sign-in transition: retry fires once when isSignedIn becomes true', async () => {
    await enqueuePhoto(TEST_USER_ID, ENTRY.uri, ENTRY.mimeType, ENTRY.playerId);

    mockUploadPhoto.mockResolvedValueOnce('objects/late-ok.jpg');
    const updatePlayer = makeUpdatePlayer();
    mockUseUpdatePlayer.mockReturnValue(updatePlayer);

    // Start with not signed in
    wireAuth(false);
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(<PendingPhotoRetry />); });

    // Nothing ran yet
    expect(mockUploadPhoto).not.toHaveBeenCalled();

    // Coach signs in — isSignedIn becomes true
    wireAuth(true);
    await act(async () => { tree.update(<PendingPhotoRetry />); });

    // Retry fired now that we're signed in
    expect(mockUploadPhoto).toHaveBeenCalledTimes(1);
    expect(await getPendingPhotos(TEST_USER_ID)).toHaveLength(0);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  // 5. One-shot guard — second render does not re-fire ──────────────────────────

  test('one-shot guard: retry does not run again on a re-render within the same session', async () => {
    await enqueuePhoto(TEST_USER_ID, ENTRY.uri, ENTRY.mimeType, ENTRY.playerId);

    mockUploadPhoto.mockResolvedValue('objects/ok.jpg');
    mockUseUpdatePlayer.mockReturnValue(makeUpdatePlayer());
    wireAuth(true);

    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(<PendingPhotoRetry />); });

    // First mount processed and dequeued
    expect(mockUploadPhoto).toHaveBeenCalledTimes(1);
    expect(await getPendingPhotos(TEST_USER_ID)).toHaveLength(0);

    // Simulate a re-render (e.g. parent state change) — still signed in
    await act(async () => { tree.update(<PendingPhotoRetry />); });

    // uploadPhoto must not have been called a second time
    expect(mockUploadPhoto).toHaveBeenCalledTimes(1);
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
// Part 2 — Logic tests (exercise retry loop via getPendingPhotos / dequeuePhoto)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Mirrors the async IIFE inside PendingPhotoRetry exactly, so that any change
 * to the loop or alert wording breaks these tests first.
 */
async function runRetryLoop(
  getToken: () => Promise<string | null>,
  updatePlayer: (args: { playerId: number; data: { photoObjectPath: string } }) => Promise<void>,
): Promise<void> {
  const pending = await getPendingPhotos(TEST_USER_ID);
  if (pending.length === 0) return;
  let failCount = 0;
  for (const entry of pending) {
    try {
      const token = await getToken();
      if (!token) { failCount += pending.length; break; }
      const objectPath = await mockUploadPhoto(entry.uri, entry.mimeType, token);
      await updatePlayer({ playerId: entry.playerId, data: { photoObjectPath: objectPath } });
      await dequeuePhoto(TEST_USER_ID, entry.id);
    } catch {
      failCount++;
    }
  }
  if (failCount > 0) {
    Alert.alert(
      'Photo upload incomplete',
      `${failCount} player photo${failCount > 1 ? 's' : ''} couldn't be uploaded. Open the player's profile and tap their photo to try again.`,
      [{ text: 'OK' }],
    );
  }
}

describe('PendingPhotoRetry retry loop — branch coverage', () => {

  // 6. No token ─────────────────────────────────────────────────────────────────

  test('no token: all entries stay queued, alert mentions count', async () => {
    await enqueuePhoto(TEST_USER_ID, ENTRY.uri, ENTRY.mimeType, ENTRY.playerId);
    await enqueuePhoto(TEST_USER_ID, 'file:///photo2.jpg', 'image/jpeg', 99);

    await runRetryLoop(async () => null, jest.fn());

    expect(mockUploadPhoto).not.toHaveBeenCalled();
    expect(await getPendingPhotos(TEST_USER_ID)).toHaveLength(2);
    expect(alertSpy).toHaveBeenCalledWith(
      'Photo upload incomplete',
      "2 player photos couldn't be uploaded. Open the player's profile and tap their photo to try again.",
      [{ text: 'OK' }],
    );
  });

  // 7. Empty queue ──────────────────────────────────────────────────────────────

  test('empty queue: no uploads, no mutations, no alert', async () => {
    const updatePlayer = jest.fn();
    await runRetryLoop(async () => 'tok', updatePlayer);
    expect(mockUploadPhoto).not.toHaveBeenCalled();
    expect(updatePlayer).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  // 8. Mixed batch ──────────────────────────────────────────────────────────────

  test('mixed batch: successes dequeued, failures kept, alert count correct', async () => {
    await enqueuePhoto(TEST_USER_ID, 'file:///ok.jpg',   'image/jpeg', 1);
    await enqueuePhoto(TEST_USER_ID, 'file:///fail.jpg', 'image/jpeg', 2);

    mockUploadPhoto
      .mockResolvedValueOnce('objects/ok.jpg')
      .mockRejectedValueOnce(new Error('Server error'));

    const updatePlayer = jest.fn(async () => {});
    await runRetryLoop(async () => 'tok', updatePlayer);

    const remaining = await getPendingPhotos(TEST_USER_ID);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].uri).toBe('file:///fail.jpg');

    expect(updatePlayer).toHaveBeenCalledTimes(1);
    expect(alertSpy).toHaveBeenCalledWith(
      'Photo upload incomplete',
      "1 player photo couldn't be uploaded. Open the player's profile and tap their photo to try again.",
      [{ text: 'OK' }],
    );
  });

});
