jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(),
    setItem: jest.fn(),
    removeItem: jest.fn(),
  },
}));
jest.mock('@/lib/uploadVideoFile', () => ({ uploadVideoFile: jest.fn() }));
jest.mock('@/lib/concatSegmentsWithTimeout', () => ({ concatSegmentsWithTimeout: jest.fn() }));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { uploadVideoFile } from '@/lib/uploadVideoFile';
import {
  PENDING_UPLOAD_KEY,
  enqueuePendingMasterUpload,
  loadPendingMasterUploads,
  removePendingMasterUpload,
  updatePendingMasterUpload,
  syncPendingMasterUpload,
  syncPendingMasterUploadIfAvailable,
  tryAcquirePendingMasterLease,
  releasePendingMasterLease,
  type PendingUpload,
} from '@/lib/pendingMasterUpload';

const store = AsyncStorage as jest.Mocked<typeof AsyncStorage>;
const upload = uploadVideoFile as jest.Mock;
let items: Record<string, string>;

const pending: PendingUpload = {
  uris: ['file:///master.mp4'],
  teamId: 4, teamName: 'Home', opponent: 'Away', date: '2026-10-01',
  teamScore: 10, opponentScore: 8, stats: {}, events: [],
  clientId: 'stable-game-id', savedAt: '2026-10-01T00:00:00.000Z',
};

function deps() {
  return {
    apiBase: 'https://api.test',
    getToken: jest.fn().mockResolvedValue('token'),
    requestUploadUrl: jest.fn().mockResolvedValue({ uploadURL: 'https://upload.test', objectPath: 'unused' }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  items = {};
  (store.getItem as jest.Mock).mockImplementation(async (key: string) => items[key] ?? null);
  (store.setItem as jest.Mock).mockImplementation(async (key: string, value: string) => { items[key] = value; });
  (store.removeItem as jest.Mock).mockImplementation(async (key: string) => { delete items[key]; });
  upload.mockResolvedValue('objects/master.mp4');
});

test('migrates the legacy single marker without losing it when another game ends', async () => {
  items[PENDING_UPLOAD_KEY] = JSON.stringify(pending);
  const second = { ...pending, clientId: 'next-game', uris: ['file:///second.mp4'] };
  await enqueuePendingMasterUpload(second);
  expect((await loadPendingMasterUploads()).map((item) => item.clientId))
    .toEqual(['stable-game-id', 'next-game']);
  await updatePendingMasterUpload(second.clientId, { uploadedPaths: ['objects/second.mp4'] });
  expect((await loadPendingMasterUploads())[0].uploadedPaths).toBeUndefined();
  await removePendingMasterUpload(second.clientId);
  expect(await loadPendingMasterUploads()).toEqual([pending]);
});

test('a failed storage write does not destroy the first game or poison subsequent writes', async () => {
  await enqueuePendingMasterUpload(pending);
  (store.setItem as jest.Mock).mockRejectedValueOnce(new Error('Storage full'));
  await expect(enqueuePendingMasterUpload({ ...pending, clientId: 'next-game' }))
    .rejects.toThrow('Storage full');
  expect(await loadPendingMasterUploads()).toEqual([pending]);
  await enqueuePendingMasterUpload({ ...pending, clientId: 'next-game' });
  expect(await loadPendingMasterUploads()).toHaveLength(2);
});

test('two recorded games survive a relaunch and completing one retains the other', async () => {
  const second = { ...pending, clientId: 'next-game', uris: ['file:///second.mp4'] };
  await enqueuePendingMasterUpload(pending);
  await enqueuePendingMasterUpload(second);
  (global as any).fetch = jest.fn()
    .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ id: 77 }) })
    .mockResolvedValueOnce({ ok: true, status: 200 })
    .mockResolvedValueOnce({ ok: true, status: 202 })
    .mockResolvedValueOnce({ ok: true, status: 202 });
  await syncPendingMasterUpload((await loadPendingMasterUploads())[0], deps());
  expect((await loadPendingMasterUploads()).map((item) => item.clientId)).toEqual(['next-game']);
  expect((await loadPendingMasterUploads())[0].uris).toEqual(['file:///second.mp4']);
});

test('worker ignores a stale snapshot after foreground already completed that game', async () => {
  await enqueuePendingMasterUpload(pending);
  await removePendingMasterUpload(pending.clientId);
  (global as any).fetch = jest.fn();
  await expect(syncPendingMasterUploadIfAvailable(pending, deps())).resolves.toBeNull();
  expect(global.fetch).not.toHaveBeenCalled();
  expect(await loadPendingMasterUploads()).toEqual([]);
});

test('offline End Game marker retains the local full-game URI until attach succeeds', async () => {
  (global as any).fetch = jest.fn().mockRejectedValue(new TypeError('Network request failed'));
  await expect(syncPendingMasterUpload(pending, deps())).rejects.toThrow('Network request failed');
  expect(store.removeItem).not.toHaveBeenCalled();
  expect(pending.uris).toEqual(['file:///master.mp4']);
});

test.each(['cellular', 'wi-fi'])('retries over usable %s and attaches the master to its idempotent game', async () => {
  const fetchMock = jest.fn()
    .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ id: 77 }) })
    .mockResolvedValueOnce({ ok: true, status: 200 })
    .mockResolvedValueOnce({ ok: true, status: 202 })
    .mockResolvedValueOnce({ ok: true, status: 202 });
  (global as any).fetch = fetchMock;

  await expect(syncPendingMasterUpload(pending, deps())).resolves.toEqual({ gameId: 77 });
  expect(upload).toHaveBeenCalledWith('file:///master.mp4', expect.any(Function), expect.any(Function));
  expect(fetchMock.mock.calls[1][0]).toContain('/api/games/77/video');
  expect(fetchMock.mock.calls[1][1].method).toBe('PATCH');
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ videoObjectPath: 'objects/master.mp4' });
  expect(store.removeItem).toHaveBeenCalled();
});

test('relaunch recovery reuses persisted gameId and clientId without creating a duplicate', async () => {
  const fetchMock = jest.fn()
    .mockResolvedValueOnce({ ok: true, status: 200 })
    .mockResolvedValueOnce({ ok: true, status: 202 })
    .mockResolvedValueOnce({ ok: true, status: 202 });
  (global as any).fetch = fetchMock;
  await syncPendingMasterUpload({ ...pending, gameId: 77, uploadedPaths: ['objects/master.mp4'] }, deps());
  expect(fetchMock.mock.calls[0][0]).toContain('/api/games/77/video');
  expect(fetchMock.mock.calls[0][1].method).toBe('PATCH');
  expect(fetchMock.mock.calls[0][1].body).toBe('{"videoObjectPath":"objects/master.mp4"}');
  expect(upload).not.toHaveBeenCalled();
});

test('preserves pending local film when attachment fails', async () => {
  const fetchMock = jest.fn()
    .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ id: 77 }) })
    .mockResolvedValueOnce({ ok: false, status: 503 });
  (global as any).fetch = fetchMock;
  await expect(syncPendingMasterUpload(pending, deps())).rejects.toThrow('503');
  expect(store.setItem).toHaveBeenCalled();
  expect(store.removeItem).not.toHaveBeenCalled();
});

test('a foreground owner blocks a worker probe from issuing a second upload or PATCH', async () => {
  expect(tryAcquirePendingMasterLease(pending.clientId)).toBe(true); // foreground holds it through save/link/reels
  try {
    (global as any).fetch = jest.fn();
    await expect(syncPendingMasterUploadIfAvailable(pending, deps())).resolves.toBeNull();
    expect(upload).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  } finally {
    releasePendingMasterLease(pending.clientId);
  }
});

test('uploading an earlier game does not block saving the next game', () => {
  expect(tryAcquirePendingMasterLease(pending.clientId)).toBe(true);
  try {
    expect(tryAcquirePendingMasterLease('next-game')).toBe(true);
    releasePendingMasterLease('next-game');
  } finally {
    releasePendingMasterLease(pending.clientId);
  }
});