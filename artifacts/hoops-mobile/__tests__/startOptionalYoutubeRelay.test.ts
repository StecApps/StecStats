import { startOptionalYoutubeRelay } from '@/lib/startOptionalYoutubeRelay';

const getToken = jest.fn().mockResolvedValue('coach-token');

beforeEach(() => {
  jest.clearAllMocks();
});

test('customers without YouTube still have Daily Live without a warning', async () => {
  (global as any).fetch = jest.fn().mockResolvedValue({
    ok: false, status: 409,
    json: async () => ({ code: 'YOUTUBE_NOT_CONNECTED' }),
  });
  await expect(startOptionalYoutubeRelay('https://example.test', 'GAME', getToken))
    .resolves.toEqual({ distributed: false });
});

test('a connected owner can also relay a separate broadcast to YouTube', async () => {
  (global as any).fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
  await expect(startOptionalYoutubeRelay('https://example.test', 'GAME', getToken))
    .resolves.toEqual({ distributed: true });
  expect(global.fetch).toHaveBeenCalledWith(
    'https://example.test/api/live/GAME/youtube/start',
    expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer coach-token' }),
    }),
  );
});

test('a failing connected relay reports the problem but does not cancel Daily', async () => {
  (global as any).fetch = jest.fn().mockResolvedValue({
    ok: false, status: 403,
    json: async () => ({ code: 'YOUTUBE_LIVE_NOT_ENABLED' }),
  });
  await expect(startOptionalYoutubeRelay('https://example.test', 'GAME', getToken))
    .resolves.toEqual(expect.objectContaining({
      distributed: false,
      warning: expect.stringContaining('Enable YouTube Live'),
    }));
});

test('a network error does not cancel Daily Live', async () => {
  (global as any).fetch = jest.fn().mockRejectedValue(new TypeError('Network request failed'));
  await expect(startOptionalYoutubeRelay('https://example.test', 'GAME', getToken))
    .resolves.toEqual({ distributed: false, warning: 'Network request failed' });
});