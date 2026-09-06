import { checkConnectivity } from '../lib/offlineQueue';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
}));

describe('checkConnectivity timeout', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('settles offline even when native fetch ignores AbortSignal', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockImplementation(() => new Promise<Response>(() => {}));

    const result = checkConnectivity('https://example.test');
    jest.advanceTimersByTime(4_000);

    await expect(result).resolves.toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][1]?.signal).toMatchObject({ aborted: true });
  });

  test('clears the deadline after a successful response', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({ status: 200 } as Response);

    await expect(checkConnectivity('https://example.test')).resolves.toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });
});