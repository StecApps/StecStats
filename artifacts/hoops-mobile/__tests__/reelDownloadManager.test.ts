const mockStorage = new Map<string, string>();
const mockFiles = new Map<string, number>();
const mockTasks: Array<{ downloadAsync: jest.Mock; pauseAsync: jest.Mock }> = [];
let mockNetworkListener: ((state: { type: any; isConnected: boolean }) => void) | undefined;

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn((key: string) => Promise.resolve(mockStorage.get(key) ?? null)),
  setItem: jest.fn((key: string, value: string) => { mockStorage.set(key, value); return Promise.resolve(); }),
  removeItem: jest.fn((key: string) => { mockStorage.delete(key); return Promise.resolve(); }),
}));
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
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
    const task = { pauseAsync: jest.fn(() => Promise.resolve({ resumeData: 'resume-token' })), downloadAsync: jest.fn(() => { mockFiles.set(uri, 2048); return Promise.resolve({ uri, status: 200, headers: { 'content-length': '2048' } }); }) };
    mockTasks.push(task); return task;
  }),
}));
jest.mock('expo-file-system', () => ({
  File: class MockFile {
    uri: string;
    constructor(uri: string) { this.uri = uri; }
    get exists() { return mockFiles.has(this.uri); }
    create() { mockFiles.set(this.uri, 0); }
    open() {
      let offset = 0;
      return {
        get offset() { return offset; },
        set offset(value: number | null) { offset = value ?? 0; },
        writeBytes: (bytes: Uint8Array) => {
          const size = mockFiles.get(this.uri) ?? 0;
          mockFiles.set(this.uri, Math.max(size, offset + bytes.byteLength));
          offset += bytes.byteLength;
        },
        close: jest.fn(),
      };
    }
  },
}));
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));

import * as FileSystem from 'expo-file-system/legacy';
import { fetch as expoFetch } from 'expo/fetch';
import { Platform } from 'react-native';
import { ReelDownloadManager } from '@/lib/reelDownloadManager';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const reel = (objectPath = 'reels/one.mp4') => ({ gameId: 7, type: 'highlight' as const, objectPath, url: `https://signed/${objectPath}` });

beforeEach(() => {
  mockStorage.clear(); mockFiles.clear(); mockTasks.splice(0); mockNetworkListener = undefined;
  Platform.OS = 'android';
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

  test('recovers an atomically promoted final file when the completion manifest write was interrupted', async () => {
    mockStorage.set('@stecstats/reel-downloads/v5/coach-a', JSON.stringify([{
      ...reel(),
      status: 'downloading',
      requestedAt: 1,
      expectedBytes: 4096,
      bytesWritten: 4096,
    }]));
    const seed = new ReelDownloadManager();
    await seed.activate('coach-a');
    const finalUri = seed.get(7, 'highlight', 'reels/one.mp4')!.uri!;

    // Recreate the crash boundary: moveAsync completed, but AsyncStorage still
    // contains the preceding "downloading" snapshot.
    mockFiles.set(finalUri, 4096);
    const relaunched = new ReelDownloadManager();
    await relaunched.activate('coach-a');

    expect(relaunched.get(7, 'highlight', 'reels/one.mp4')).toMatchObject({
      status: 'downloaded',
      uri: finalUri,
      sizeBytes: 4096,
    });
    expect(mockFiles.has(finalUri)).toBe(true);
  });

  test('serializes manifest writes so stale download progress cannot overwrite completion', async () => {
    const manager = new ReelDownloadManager();
    await manager.activate('coach-a');
    await manager.enqueue(reel());
    const entry = manager.get(7, 'highlight', 'reels/one.mp4')!;
    const storage = jest.requireMock('@react-native-async-storage/async-storage');
    let releaseProgress!: () => void;
    let writeCount = 0;
    storage.setItem.mockImplementation((storageKey: string, value: string) => {
      writeCount += 1;
      if (writeCount === 1) {
        return new Promise<void>((resolve) => {
          releaseProgress = () => {
            mockStorage.set(storageKey, value);
            resolve();
          };
        });
      }
      mockStorage.set(storageKey, value);
      return Promise.resolve();
    });

    entry.status = 'downloading';
    const progressWrite = manager.persist();
    await flush();
    entry.status = 'downloaded';
    const completionWrite = manager.persist();
    await flush();
    expect(writeCount).toBe(1);

    releaseProgress();
    await Promise.all([progressWrite, completionWrite]);
    expect(JSON.parse(mockStorage.get('@stecstats/reel-downloads/v5/coach-a')!)[0].status).toBe('downloaded');
  });

  test('resumes retained partial bytes after process recreation with a refreshed signed URL', async () => {
    Platform.OS = 'ios';
    const first = new ReelDownloadManager();
    await first.activate('coach-a');
    let reads = 0;
    (expoFetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: (name: string) => name.toLowerCase() === 'content-length' ? '4194304' : null },
      body: { getReader: () => ({
        read: jest.fn(() => {
          reads += 1;
          if (reads === 1) return Promise.resolve({ done: false, value: new Uint8Array(2097152) });
          return new Promise(() => undefined);
        }),
        cancel: jest.fn(),
      }) },
    });
    first.setNetworkForTesting('wifi', true);
    await first.enqueue(reel());
    await flush();
    const finalUri = first.get(7, 'highlight', 'reels/one.mp4')!.uri!;
    await flush();
    expect(mockFiles.get(`${finalUri}.part`)).toBe(2097152);

    const relaunched = new ReelDownloadManager();
    await relaunched.activate('coach-a');
    relaunched.setNetworkForTesting('wifi', true);
    await flush();
    expect(mockFiles.get(`${finalUri}.part`)).toBe(2097152);
    expect(expoFetch).toHaveBeenCalledTimes(1);

    (expoFetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 206,
      headers: { get: (name: string) => {
        if (name.toLowerCase() === 'content-range') return 'bytes 2097152-4194303/4194304';
        if (name.toLowerCase() === 'content-length') return '2097152';
        return null;
      } },
      body: { getReader: () => ({
        read: jest.fn()
          .mockResolvedValueOnce({ done: false, value: new Uint8Array(2097152) })
          .mockResolvedValueOnce({ done: true }),
        cancel: jest.fn(),
      }) },
    });
    await relaunched.enqueue({ ...reel(), url: 'https://signed/fresh-token' });
    await flush();
    const resumeCall = (expoFetch as jest.Mock).mock.calls[1];
    expect(resumeCall[0]).toBe('https://signed/fresh-token');
    expect(resumeCall[1].headers).toEqual({ Range: 'bytes=2097152-' });
    expect(relaunched.get(7, 'highlight', 'reels/one.mp4')?.status).toBe('downloaded');
    expect(mockFiles.get(finalUri)).toBe(4194304);
  });

  test('keeps iOS partial bytes when Wi-Fi roaming interrupts the active fetch', async () => {
    Platform.OS = 'ios';
    (expoFetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: (name: string) => name.toLowerCase() === 'content-length' ? '4096' : null },
      body: { getReader: () => ({
        read: jest.fn()
          .mockResolvedValueOnce({ done: false, value: new Uint8Array(2048) })
          .mockRejectedValueOnce(new Error('Network connection was lost')),
        cancel: jest.fn(),
      }) },
    });
    const manager = new ReelDownloadManager();
    await manager.activate('coach-a');
    manager.setNetworkForTesting('wifi', true);
    await manager.enqueue(reel());
    await flush();
    await flush();

    const interrupted = manager.get(7, 'highlight', 'reels/one.mp4')!;
    expect(interrupted).toMatchObject({
      status: 'queued',
      bytesWritten: 2048,
      expectedBytes: 4096,
      needsUrlRefresh: true,
    });
    expect(mockFiles.get(`${interrupted.uri}.part`)).toBe(2048);

    (expoFetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 206,
      headers: { get: (name: string) => {
        if (name.toLowerCase() === 'content-range') return 'bytes 2048-4095/4096';
        if (name.toLowerCase() === 'content-length') return '2048';
        return null;
      } },
      body: { getReader: () => ({
        read: jest.fn()
          .mockResolvedValueOnce({ done: false, value: new Uint8Array(2048) })
          .mockResolvedValueOnce({ done: true }),
        cancel: jest.fn(),
      }) },
    });
    await manager.enqueue({ ...reel(), url: 'https://signed/refreshed' });
    await flush();
    await flush();

    expect(manager.get(7, 'highlight', 'reels/one.mp4')?.status).toBe('downloaded');
    expect(mockFiles.get(interrupted.uri!)).toBe(4096);
  });

  test('never restores another account resumable transfer', async () => {
    const manager = new ReelDownloadManager();
    await manager.activate('coach-a');
    await manager.enqueue(reel());
    const entry = manager.get(7, 'highlight', 'reels/one.mp4')!;
    entry.status = 'queued';
    entry.resumeData = 'coach-a-resume';
    entry.needsUrlRefresh = true;
    mockFiles.set(`${entry.uri}.part`, 4096);
    await manager.persist();

    const relaunched = new ReelDownloadManager();
    await relaunched.activate('coach-b');
    relaunched.setNetworkForTesting('wifi', true);
    await relaunched.enqueue(reel());
    await flush();
    expect((FileSystem.createDownloadResumable as jest.Mock).mock.calls.at(-1)?.[4]).toBeUndefined();
    expect((FileSystem.createDownloadResumable as jest.Mock).mock.calls.at(-1)?.[1]).not.toBe(`${entry.uri}.part`);
  });

  test('stores durable offline reels outside the purgeable cache directory', async () => {
    const manager = new ReelDownloadManager();
    await manager.activate('coach-a'); manager.setNetworkForTesting('wifi', true);
    await manager.enqueue(reel()); await flush();
    expect(manager.get(7, 'highlight', 'reels/one.mp4')?.uri).toContain('file:///documents/reels/');
  });

  test('discards obsolete v1-v4 downloads that may contain damaged media', async () => {
    const v1Uri = 'file:///cache/reels/old/highlight-7-old.mp4';
    const v2Uri = 'file:///documents/reels/coach/highlight-7-v2.mp4';
    const v3Uri = 'file:///documents/reels/coach/highlight-7-v3.mp4';
    const v4Uri = 'file:///documents/reels/coach/highlight-7-v4.mp4';
    mockFiles.set(v1Uri, 4096);
    mockFiles.set(v2Uri, 8192);
    mockFiles.set(v3Uri, 8192);
    mockFiles.set(v4Uri, 8192);
    mockStorage.set('@stecstats/reel-downloads/v1/coach-a', JSON.stringify([{
      ...reel(), status: 'downloaded', requestedAt: 1, uri: v1Uri,
    }]));
    mockStorage.set('@stecstats/reel-downloads/v2/coach-a', JSON.stringify([{
      ...reel('reels/two.mp4'), status: 'downloaded', requestedAt: 2, uri: v2Uri,
    }]));
    mockStorage.set('@stecstats/reel-downloads/v3/coach-a', JSON.stringify([{
      ...reel('reels/three.mp4'), status: 'downloaded', requestedAt: 3, uri: v3Uri,
    }]));
    mockStorage.set('@stecstats/reel-downloads/v4/coach-a', JSON.stringify([{
      ...reel('reels/four.mp4'), status: 'downloaded', requestedAt: 4, uri: v4Uri,
    }]));
    const manager = new ReelDownloadManager();
    await manager.activate('coach-a');
    expect(manager.get(7, 'highlight', 'reels/one.mp4')).toBeUndefined();
    expect(manager.get(7, 'highlight', 'reels/two.mp4')).toBeUndefined();
    expect(manager.get(7, 'highlight', 'reels/three.mp4')).toBeUndefined();
    expect(manager.get(7, 'highlight', 'reels/four.mp4')).toBeUndefined();
    expect(mockFiles.has(v1Uri)).toBe(false);
    expect(mockFiles.has(v2Uri)).toBe(false);
    expect(mockFiles.has(v3Uri)).toBe(false);
    expect(mockFiles.has(v4Uri)).toBe(false);
    expect(mockStorage.has('@stecstats/reel-downloads/v1/coach-a')).toBe(false);
    expect(mockStorage.has('@stecstats/reel-downloads/v2/coach-a')).toBe(false);
    expect(mockStorage.has('@stecstats/reel-downloads/v3/coach-a')).toBe(false);
    expect(mockStorage.has('@stecstats/reel-downloads/v4/coach-a')).toBe(false);
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
    finish({ uri: 'file:///cache/late.mp4', status: 200, headers: { 'content-length': '4096' } } as any); mockFiles.set('file:///cache/late.mp4', 4096); await flush();
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
      if (storageKey === '@stecstats/reel-downloads/v5/coach-a') return coachARead;
      if (storageKey === '@stecstats/reel-downloads/v5/coach-b') return Promise.resolve('[]');
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
      pauseAsync: jest.fn(), downloadAsync: jest.fn(() => { mockFiles.set(uri, 10); return Promise.resolve({ uri, status: 200, headers: { 'content-length': '2048' } }); }),
    }));
    await manager.enqueue(reel()); await flush();
    expect(manager.get(7, 'highlight', 'reels/one.mp4')?.status).toBe('failed');
    expect(mockFiles.size).toBe(0);
    await manager.retry(7, 'highlight', 'reels/one.mp4'); await flush();
    expect((FileSystem.createDownloadResumable as jest.Mock).mock.calls[0][2]).toEqual({ sessionType: 0 });
    expect((FileSystem.createDownloadResumable as jest.Mock).mock.calls.length).toBe(2);
  });

  test('rejects a same-size download when its checksum does not match the server object', async () => {
    const manager = new ReelDownloadManager();
    await manager.activate('coach-a');
    manager.setNetworkForTesting('wifi', true);
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation((uri: string, options?: { md5?: boolean }) =>
      Promise.resolve({
        exists: mockFiles.has(uri),
        uri,
        size: mockFiles.get(uri) ?? 0,
        md5: options?.md5 ? 'damaged-file-checksum' : undefined,
      }));
    (FileSystem.createDownloadResumable as jest.Mock).mockImplementationOnce((_url, uri) => ({
      pauseAsync: jest.fn(),
      downloadAsync: jest.fn(() => {
        mockFiles.set(uri, 2048);
        return Promise.resolve({
          uri,
          status: 200,
          headers: {
            'content-length': '2048',
            'x-content-md5': 'server-object-checksum',
          },
        });
      }),
    }));

    await manager.enqueue(reel());
    await flush();
    await flush();

    expect(manager.get(7, 'highlight', 'reels/one.mp4')).toMatchObject({
      status: 'queued',
      bytesWritten: 0,
      needsUrlRefresh: true,
    });
    expect(mockFiles.size).toBe(0);
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
    mockFiles.set(`${uri}.part`, 2048); finish({ uri: `${uri}.part`, status: 200, headers: { 'content-length': '2048' } } as any); await flush();
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
    mockFiles.set(`${uri}.part`, 4096); finish({ uri: `${uri}.part`, status: 200, headers: { 'content-length': '4096' } } as any); await flush();
    expect(manager.get(7, 'highlight', 'reels/one.mp4')).toBeUndefined();
    expect(mockFiles.has(uri)).toBe(false);
  });

  test('recovers malformed and interrupted persisted manifests as safe retryable failures', async () => {
    mockStorage.set('@stecstats/reel-downloads/v5/coach-a', '{bad json');
    const malformed = new ReelDownloadManager(); await expect(malformed.activate('coach-a')).resolves.toBeUndefined();
    mockStorage.set('@stecstats/reel-downloads/v5/coach-b', JSON.stringify([{ ...reel(), status: 'downloading', requestedAt: 1, uri: 'file:///cache/partial' }]));
    mockFiles.set('file:///cache/partial', 99);
    const interrupted = new ReelDownloadManager(); await interrupted.activate('coach-b');
    expect(interrupted.get(7, 'highlight', 'reels/one.mp4')?.status).toBe('failed');
    // A corrupted manifest must not be able to delete an arbitrary persisted URI.
    expect(mockFiles.has('file:///cache/partial')).toBe(true);
  });
});