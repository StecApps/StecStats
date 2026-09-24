import { getSeekableGameFilm } from '../lib/seekableGameFilm';

const mockFiles = new Map<string, number>();
const mockDownloadAsync = jest.fn(async (_url: string, destination: string) => {
  mockFiles.set(destination, 5000);
  return { status: 200, headers: { 'content-length': '5000' } };
});

jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  makeDirectoryAsync: jest.fn(async () => {}),
  getInfoAsync: jest.fn(async (uri: string) =>
    mockFiles.has(uri) ? { exists: true, size: mockFiles.get(uri) } : { exists: false }),
  deleteAsync: jest.fn(async (uri: string) => { mockFiles.delete(uri); }),
  moveAsync: jest.fn(async ({ from, to }: { from: string; to: string }) => {
    mockFiles.set(to, mockFiles.get(from)!);
    mockFiles.delete(from);
  }),
  downloadAsync: (...args: [string, string]) => mockDownloadAsync(...args),
}));

beforeEach(() => {
  mockFiles.clear();
  mockDownloadAsync.mockClear();
});

test('downloads one complete local copy and reuses it for subsequent seeks', async () => {
  const url = 'https://storage.example/game.mp4?signature=one';
  const [first, second] = await Promise.all([
    getSeekableGameFilm(206, '/proxy/game-206', url),
    getSeekableGameFilm(206, '/proxy/game-206', url),
  ]);
  expect(first).toBe(second);
  expect(first).toMatch(/\.mp4$/);
  expect(mockDownloadAsync).toHaveBeenCalledTimes(1);
  expect(await getSeekableGameFilm(206, '/proxy/game-206', 'https://storage.example/game.mp4?signature=two'))
    .toBe(first);
  expect(mockDownloadAsync).toHaveBeenCalledTimes(1);
});

test('rejects truncated downloads rather than attaching them to AVPlayer', async () => {
  mockDownloadAsync.mockImplementationOnce(async (_url, destination) => {
    mockFiles.set(destination, 1000);
    return { status: 200, headers: { 'content-length': '5000' } };
  });
  await expect(getSeekableGameFilm(207, '/proxy/game-207', 'https://storage.example/207.mp4'))
    .rejects.toThrow('incomplete');
  expect([...mockFiles.keys()]).toEqual([]);
});