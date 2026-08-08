/**
 * drainPendingViewers.test.ts
 *
 * Verifies the pending-viewer queue drain behavior introduced to handle the
 * camera-flip timing race:
 *
 *   When the broadcaster flips the camera, the WebRTC stream useEffect closes
 *   all peers and calls getUserMedia again. A viewer may send `new-viewer`
 *   during that async window — before the replacement stream resolves. The
 *   handler queues those viewer IDs in pendingViewerIdsRef instead of silently
 *   skipping them. drainPendingViewers() is called once getUserMedia succeeds
 *   and creates peer connections for every queued viewer atomically.
 *
 * Covers:
 *   1. Queued viewers all get offers once the stream is ready.
 *   2. The pending array is cleared (splice) so a concurrent new-viewer doesn't
 *      re-drain the same IDs.
 *   3. No offers are sent when the stream is null (pre-resolution state).
 *   4. No offers are sent when the queue is empty (stream ready, no waiters).
 *   5. A failed createPeerForViewer doesn't abort the other pending offers.
 */

import { drainPendingViewers } from '../lib/drainPendingViewers';

const fakeStream = { getTracks: () => [] };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('drainPendingViewers — stream is ready', () => {
  test('calls createPeerForViewer once for each queued viewer ID', async () => {
    const pending = ['viewer-1', 'viewer-2', 'viewer-3'];
    const offered: string[] = [];
    const createPeer = jest.fn().mockImplementation(async (id: string) => {
      offered.push(id);
    });

    await drainPendingViewers(pending, fakeStream, createPeer);

    expect(createPeer).toHaveBeenCalledTimes(3);
    expect(offered).toEqual(expect.arrayContaining(['viewer-1', 'viewer-2', 'viewer-3']));
  });

  test('clears the pending array atomically so IDs are not re-offered', async () => {
    const pending = ['viewer-1', 'viewer-2'];
    const createPeer = jest.fn().mockResolvedValue(undefined);

    await drainPendingViewers(pending, fakeStream, createPeer);

    // The array must be empty after the drain — no double-offer on a second call.
    expect(pending).toHaveLength(0);
  });

  test('a second call on an already-drained queue is a no-op', async () => {
    const pending = ['viewer-1'];
    const createPeer = jest.fn().mockResolvedValue(undefined);

    await drainPendingViewers(pending, fakeStream, createPeer);
    await drainPendingViewers(pending, fakeStream, createPeer);

    expect(createPeer).toHaveBeenCalledTimes(1);
  });

  test('a single viewer error does not abort the remaining offers', async () => {
    const pending = ['viewer-ok', 'viewer-fail', 'viewer-ok-2'];
    const offered: string[] = [];
    const createPeer = jest.fn().mockImplementation(async (id: string) => {
      if (id === 'viewer-fail') throw new Error('peer setup failed');
      offered.push(id);
    });

    await expect(drainPendingViewers(pending, fakeStream, createPeer)).resolves.not.toThrow();
    expect(offered).toEqual(expect.arrayContaining(['viewer-ok', 'viewer-ok-2']));
  });
});

describe('drainPendingViewers — stream is null (getUserMedia not yet resolved)', () => {
  test('does nothing when stream is null', async () => {
    const pending = ['viewer-1', 'viewer-2'];
    const createPeer = jest.fn();

    await drainPendingViewers(pending, null, createPeer);

    expect(createPeer).not.toHaveBeenCalled();
    // IDs are NOT drained — they stay in the queue for when the stream opens.
    expect(pending).toHaveLength(2);
  });

  test('does nothing when stream is undefined', async () => {
    const pending = ['viewer-1'];
    const createPeer = jest.fn();

    await drainPendingViewers(pending, undefined, createPeer);

    expect(createPeer).not.toHaveBeenCalled();
    expect(pending).toHaveLength(1);
  });
});

describe('drainPendingViewers — empty queue', () => {
  test('is a no-op when the pending list is empty', async () => {
    const pending: string[] = [];
    const createPeer = jest.fn();

    await drainPendingViewers(pending, fakeStream, createPeer);

    expect(createPeer).not.toHaveBeenCalled();
  });
});
