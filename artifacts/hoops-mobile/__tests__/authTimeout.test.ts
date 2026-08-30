import {
  AuthRequestTimeoutError,
  withAuthTimeout,
} from '../lib/authTimeout';

describe('withAuthTimeout', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('returns a Clerk result that completes in time', async () => {
    await expect(
      withAuthTimeout(Promise.resolve('complete'), 'signing in', 50),
    ).resolves.toBe('complete');
  });

  test('rejects a stalled Clerk request with an actionable error', async () => {
    jest.useFakeTimers();
    const request = withAuthTimeout(
      new Promise<never>(() => {}),
      'starting email sign-in',
      1_000,
    );

    jest.advanceTimersByTime(1_000);

    await expect(request).rejects.toEqual(
      expect.objectContaining({
        name: 'AuthRequestTimeoutError',
        operation: 'starting email sign-in',
        message: expect.stringContaining('Check your connection and try again'),
      }),
    );
    await expect(request).rejects.toBeInstanceOf(AuthRequestTimeoutError);
  });

  test('preserves Clerk errors that arrive before the timeout', async () => {
    const clerkError = new Error('Clerk rejected the request');
    await expect(
      withAuthTimeout(Promise.reject(clerkError), 'signing in', 50),
    ).rejects.toBe(clerkError);
  });
});