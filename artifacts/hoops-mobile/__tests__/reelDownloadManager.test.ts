const mockStorage = new Map<string, string>();
const mockFiles = new Map<string, number>();
const mockTasks: Array<{ downloadAsync: jest.Mock; pauseAsync: jest.Mock }> = [];
let mockNetworkListener: ((state: { type: any; isConnected: boolean }) => void) | undefined;

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn((key: string) => Promise.resolve(mockStorage.get(key) ?? null)),
  setItem: jest.fn((key: string, value: string) => { mockStorage.set(key, value); return Promise.resolve(); }),
  removeItem: jest.fn((key: string) => { mockStorage.delete(key); return Promise.resolve(); }),
}));
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { addEventListener: jest.fn((listener) => { mockNetworkListener = listener; return jest.fn(); }) },
}));
jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  documentDirectory: 'file:///documents/',
  FileSystemSessionType: { BACKGROUND: 0 },
  getInfoAsync: jest.fn((uri: string) => Promise.resolve({ exists: mockFiles.has(uri), uri, size: mockFiles.get(uri) ?? 0 })),
  deleteAsync: jest.fn((uri: string) => { mockFiles.delete(uri); return Promise.resolve(); }),
  moveAsync: jest.fn(({ from, to }: { from: string; to: string }) => {
    const size = mockFiles.get(from);
    mockFiles.delete(from);
    if (size != null) mockFiles.set(to, size);
    return Promise.resolve();
  }),
  makeDirectoryAsync: jest.fn(() => Promise.resolve()),
  createDownloadResumable: jest.fn((_url: string, uri: string, options: unknown) => {
    const task = { pauseAsync: jest.fn(() => Promise.resolve()), downloadAsync: jest.fn(() => { mockFiles.set(uri, 2048); return Promise.resolve({ uri }); }) };
    mockTasks.push(task); return task;
  }),
}));

import * as FileSystem from 'expo-file-system/legacy';
import { ReelDownloadManager } from '@/lib/reelDownloadManager';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const reel = (objectPath = 'reels/one.mp4') => ({ gameId: 7, type: 'highlight' as const, objectPath, url: `https://signed/${objectPath}` });

beforeEach(() => {
  mockStorage.clear(); mockFiles.clear(); mockTasks.splice(0); mockNetworkListener = undefined;
  jest.clearAllMocks();
  const storage = jest.requireMock('@react-native-async-storage/async-storage');
  storage.getItem.mockImplementation((storageKey: string) => Promise.resolve(mockStorage.get(storageKey) ?? null));
  storage.setItem.mockImplementation((storageKey: string, value: string) => {
    mockStorage.set(storageKey, value);
    return Promise.resolve();
  });
  storage.removeItem.mockImplementation((storageKey: string) => {
    mockStorage.delete(storageKey);
    return Promise.resolve();
  });
});

describe('ReelDownloadManager behavior', () => {
  test('reuses a validated completed file after relaunch', async () => {
    const first = new ReelDownloadManager();
    await first.activate('coach-a'); first.setNetworkForTesting('wifi', true);
    await first.enqueue(reel()); await flush();
    const uri = first.get(7, 'highlight', 'reels/one.mp4')!.uri!;
    mockFiles.set(uri, 2048);
    // The mock completion above already persisted the downloaded manifest.
    await flush();
    const relaunched = new ReelDownloadManager();
    await relaunched.activate('coach-a');
    expect(relaunched.get(7, 'highlight', 'reels/one.mp4')?.status).toBe('downloaded');
  });

  test('stores durable offline reels outside the purgeable cache directory', async () => {
    const manager = new ReelDownloadManager();
    await manager.activate('coach-a'); manager.setNetworkForTesting('wifi', true);
    await manager.enqueue(reel()); await flush();
    expect(manager.get(7, 'highlight', 'reels/one.mp4')?.uri).toContain('file:///documents/reels/');
  });

  test('migrates previously downloaded cache files into durable storage', async () => {
    const oldUri = 'file:///cache/reels/old/highlight-7-old.mp4';
    mockFiles.set(oldUri, 4096);
    mockStorage.set('@stecstats/reel-downloads/v1/coach-a', JSON.stringify([{
      ...reel(), status: 'downloaded', requestedAt: 1, uri: oldUri,
    }]));
    const manager = new ReelDownloadManager();
    await manager.activate('coach-a');
    const migrated = manager.get(7, 'highlight', 'reels/one.mp4');
    expect(migrated?.uri).toContain('file:///documents/reels/');
    expect(mockFiles.has(oldUri)).toBe(false);
    expect(FileSystem.moveAsync).toHaveBeenCalled();
  });

  test('isolates accounts and ignores an old transfer callback', async () => {
    const manager = new ReelDownloadManager();
    await manager.activate('coach-a'); manager.setNetworkForTesting('wifi', true);
    let finish!: (value: { uri: string }) => void;
    (FileSystem.createDownloadResumable as jest.Mock).mockImplementationOnce((_u, uri) => {
      const task = { pauseAsync: jest.fn(() => Promise.resolve()), downloadAsync: jest.fn(() => new Promise((resolve) => { finish = resolve; })) };
      mockTasks.push(task); return task;
    });
    await manager.enqueue(reel()); await flush();
    await manager.activate('coach-b');
    finish({ uri: 'file:///cache/late.mp4' }); mockFiles.set('file:///cache/late.mp4', 4096); await flush();
    expect(mockTasks[0].pauseAsync).toHaveBeenCalled();
    expect(manager.snapshot()).toEqual([]);
    expect(mockFiles.has('file:///cache/late.mp4')).toBe(false);

    // The old callback must not consume or corrupt the new account's two slots.
    (FileSystem.createDownloadResumable as jest.Mock).mockImplementation((_u, uri) => {
      const task = { pauseAsync: jest.fn(() => Promise.resolve()), downloadAsync: jest.fn(() => new Promise(() => undefined)) };
      mockTasks.push(task); return task;
    });
    manager.setNetworkForTesting('wifi', true);
    await manager.enqueue(reel('new-a'));
    await manager.enqueue(reel('new-b'));
    await manager.enqueue(reel('new-c'));
    await flush();
    expect(mockTasks).toHaveLength(3);
  });

  test('serializes rapid account activations so the prior manifest cannot win late', async () => {
    const storage = jest.requireMock('@react-native-async-storage/async-storage');
    let releaseCoachA!: (value: string | null) => void;
    const coachARead = new Promise<string | null>((resolve) => { releaseCoachA = resolve; });
    storage.getItem.mockImplementation((storageKey: string) => {
      if (storageKey === '@stecstats/reel-downloads/v1/coach-a') return coachARead;
      if (storageKey === '@stecstats/reel-downloads/v1/coach-b') return Promise.resolve('[]');
      return Promise.resolve(null);
    });
    const manager = new ReelDownloadManager();
    const activatingA = manager.activate('coach-a');
    const activatingB = manager.activate('coach-b');
    releaseCoachA(JSON.stringify([{ ...reel('coach-a-only'), status: 'failed', requestedAt: 1 }]));
    await Promise.all([activatingA, activatingB]);
    expect(manager.snapshot()).toEqual([]);
  });

  test('keys regenerated object paths separately and invalidates only the old generation', async () => {
    const manager = new ReelDownloadManager(); await manager.activate('coach-a');
    await manager.enqueue(reel('old.mp4')); await manager.enqueue(reel('new.mp4'));
    const oldUri = manager.get(7, 'highlight', 'old.mp4')!.uri!;
    mockFiles.set(oldUri, 4096);
    await manager.invalidate(7, 'highlight', 'old.mp4');
    expect(manager.get(7, 'highlight', 'old.mp4')).toBeUndefined();
    expect(manager.get(7, 'highlight', 'new.mp4')).toBeDefined();
    expect(mockFiles.has(oldUri)).toBe(false);
  });

  test('cleans partial files, exposes failure, and retries with background options', async () => {
    const manager = new ReelDownloadManager(); await manager.activate('coach-a'); manager.setNetworkForTesting('wifi', true);
    (FileSystem.createDownloadResumable as jest.Mock).mockImplementationOnce((_u, uri) => ({
      pauseAsync: jest.fn(), downloadAsync: jest.fn(() => { mockFiles.set(uri, 10); return Promise.resolve({ uri }); }),
    }));
    await manager.enqueue(reel()); await flush();
    expect(manager.get(7, 'highlight', 'reels/one.mp4')?.status).toBe('failed');
    expect(mockFiles.size).toBe(0);
    await manager.retry(7, 'highlight', 'reels/one.mp4'); await flush();
    expect((FileSystem.createDownloadResumable as jest.Mock).mock.calls[0][2]).toEqual({ sessionType: 0 });
    expect((FileSystem.createDownloadResumable as jest.Mock).mock.calls.length).toBe(2);
  });

  test('gates cellular, responds to live network changes, and limits concurrent priority work', async () => {
    const manager = new ReelDownloadManager(); await manager.activate('coach-a');
    (FileSystem.createDownloadResumable as jest.Mock).mockImplementation((_u, uri) => {
      const task = { pauseAsync: jest.fn(() => Promise.resolve()), downloadAsync: jest.fn(() => new Promise(() => undefined)) };
      mockTasks.push(task); return task;
    });
    await manager.enqueue(reel('a')); await manager.enqueue(reel('b')); await manager.enqueue(reel('priority'), true);
    manager.setNetworkForTesting('cellular', true); await flush();
    expect(mockTasks).toHaveLength(0);
    await manager.setCellularAllowed(true); await flush();
    expect(mockTasks).toHaveLength(2);
    expect((FileSystem.createDownloadResumable as jest.Mock).mock.calls[0][0]).toContain('priority');
    mockNetworkListener?.({ type: 'none', isConnected: false });
    await manager.enqueue(reel('offline')); await flush();
    expect(mockTasks).toHaveLength(2);
  });

  test('does not start a second writer when discovery and playback enqueue the same active reel', async () => {
    const manager = new ReelDownloadManager(); await manager.activate('coach-a');
    let finish!: (value: { uri: string }) => void;
    (FileSystem.createDownloadResumable as jest.Mock).mockImplementationOnce((_u, uri) => {
      const task = { pauseAsync: jest.fn(() => Promise.resolve()), downloadAsync: jest.fn(() => new Promise((resolve) => { finish = resolve; })) };
      mockTasks.push(task); return task;
    });
    manager.setNetworkForTesting('wifi', true);
    await manager.enqueue(reel());
    await flush();
    await manager.enqueue({ ...reel(), url: 'https://signed/new-token' }, true);
    await flush();
    expect(FileSystem.createDownloadResumable).toHaveBeenCalledTimes(1);
    expect(manager.get(7, 'highlight', 'reels/one.mp4')?.status).toBe('downloading');
    const uri = manager.get(7, 'highlight', 'reels/one.mp4')!.uri!;
    mockFiles.set(uri, 2048); finish({ uri }); await flush();
    expect(manager.get(7, 'highlight', 'reels/one.mp4')?.status).toBe('downloaded');
  });

  test('invalidating an active generation pauses it and deletes any late completion', async () => {
    const manager = new ReelDownloadManager(); await manager.activate('coach-a');
    let finish!: (value: { uri: string }) => void;
    const pauseAsync = jest.fn(() => Promise.resolve());
    (FileSystem.createDownloadResumable as jest.Mock).mockImplementationOnce((_u, uri) => {
      const task = { pauseAsync, downloadAsync: jest.fn(() => new Promise((resolve) => { finish = resolve; })) };
      mockTasks.push(task); return task;
    });
    manager.setNetworkForTesting('wifi', true);
    await manager.enqueue(reel());
    await flush();
    const uri = manager.get(7, 'highlight', 'reels/one.mp4')!.uri!;
    await manager.invalidate(7, 'highlight', 'reels/one.mp4');
    expect(pauseAsync).toHaveBeenCalled();
    expect(manager.get(7, 'highlight', 'reels/one.mp4')).toBeUndefined();
    mockFiles.set(uri, 4096); finish({ uri }); await flush();
    expect(manager.get(7, 'highlight', 'reels/one.mp4')).toBeUndefined();
    expect(mockFiles.has(uri)).toBe(false);
  });

  test('recovers malformed and interrupted persisted manifests as safe retryable failures', async () => {
    mockStorage.set('@stecstats/reel-downloads/v1/coach-a', '{bad json');
    const malformed = new ReelDownloadManager(); await expect(malformed.activate('coach-a')).resolves.toBeUndefined();
    mockStorage.set('@stecstats/reel-downloads/v1/coach-b', JSON.stringify([{ ...reel(), status: 'downloading', requestedAt: 1, uri: 'file:///cache/partial' }]));
    mockFiles.set('file:///cache/partial', 99);
    const interrupted = new ReelDownloadManager(); await interrupted.activate('coach-b');
    expect(interrupted.get(7, 'highlight', 'reels/one.mp4')?.status).toBe('failed');
    expect(mockFiles.has('file:///cache/partial')).toBe(false);
  });
});