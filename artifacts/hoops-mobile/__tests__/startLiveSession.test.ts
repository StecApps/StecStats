import {
  LiveSessionTimeoutError,
  startLiveSession,
} from '../lib/startLiveSession';

describe('startLiveSession', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    (global as any).fetch = jest.fn();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('times out when Clerk token retrieval hangs and does not start fetch', async () => {
    const request = startLiveSession({
      apiBase: 'https://example.test',
      opponent: 'Rivals',
      teamName: 'Home',
      requestId: '28cff25b-25ae-458b-a138-e60925b3e18e',
      getToken: () => new Promise<string | null>(() => {}),
      timeoutMs: 1_000,
    });

    jest.advanceTimersByTime(1_000);

    await expect(request).rejects.toBeInstanceOf(LiveSessionTimeoutError);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('aborts a hung start request and returns a share-link timeout', async () => {
    (global.fetch as jest.Mock).mockImplementation(
      (_url: string, options: RequestInit) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            { once: true },
          );
        }),
    );

    const request = startLiveSession({
      apiBase: 'https://example.test',
      opponent: 'Rivals',
      teamName: 'Home',
      requestId: '28cff25b-25ae-458b-a138-e60925b3e18e',
      getToken: async () => 'token',
      timeoutMs: 1_000,
    });
    await Promise.resolve();
    jest.advanceTimersByTime(1_000);

    await expect(request).rejects.toMatchObject({
      message: 'Creating the share link timed out. Check your connection and try again.',
    });
  });

  test('sends the authenticated request before the deadline', async () => {
    const response = { ok: true } as Response;
    (global.fetch as jest.Mock).mockResolvedValue(response);

    await expect(startLiveSession({
      apiBase: 'https://example.test',
      opponent: 'Rivals',
      teamName: 'Home',
      requestId: '28cff25b-25ae-458b-a138-e60925b3e18e',
      getToken: async () => 'token',
    })).resolves.toBe(response);

    expect(global.fetch).toHaveBeenCalledWith(
      'https://example.test/api/live/start',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token',
        },
        body: JSON.stringify({
          opponent: 'Rivals',
          teamName: 'Home',
          requestId: '28cff25b-25ae-458b-a138-e60925b3e18e',
        }),
        signal: expect.any(Object),
      }),
    );
  });

  test('sends the same caller-provided request ID on a retry', async () => {
    const response = { ok: true } as Response;
    (global.fetch as jest.Mock).mockResolvedValue(response);
    const params = {
      apiBase: 'https://example.test',
      opponent: 'Rivals',
      teamName: 'Home',
      requestId: 'retry-request-id-0001',
      getToken: async () => 'token',
    };

    await startLiveSession(params);
    await startLiveSession(params);

    const requestBodies = (global.fetch as jest.Mock).mock.calls.map(
      ([, options]: [string, RequestInit]) => JSON.parse(options.body as string),
    );
    expect(requestBodies).toEqual([
      expect.objectContaining({ requestId: params.requestId }),
      expect.objectContaining({ requestId: params.requestId }),
    ]);
  });
});