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
  syncPendingMasterUpload,
  syncPendingMasterUploadIfAvailable,
  tryAcquirePendingMasterLease,
  releasePendingMasterLease,
  type PendingUpload,
} from '@/lib/pendingMasterUpload';

const store = AsyncStorage as jest.Mocked<typeof AsyncStorage>;
const upload = uploadVideoFile as jest.Mock;

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
  upload.mockResolvedValue('objects/master.mp4');
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
  expect(tryAcquirePendingMasterLease()).toBe(true); // foreground holds it through save/link/reels
  try {
    (global as any).fetch = jest.fn();
    await expect(syncPendingMasterUploadIfAvailable(pending, deps())).resolves.toBeNull();
    expect(upload).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  } finally {
    releasePendingMasterLease();
  }
});