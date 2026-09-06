export const LIVE_SESSION_TIMEOUT_MS = 10_000;

export class LiveSessionTimeoutError extends Error {
  constructor() {
    super('Creating the share link timed out. Check your connection and try again.');
    this.name = 'LiveSessionTimeoutError';
  }
}

interface StartLiveSessionParams {
  apiBase: string;
  opponent: string;
  teamName: string;
  requestId: string;
  getToken: () => Promise<string | null>;
  timeoutMs?: number;
}

/**
 * Creates a live session with one deadline covering both Clerk token retrieval
 * and the HTTP request. Native fetch can otherwise remain pending indefinitely
 * after a radio handoff, leaving the Go Live control permanently busy.
 */
export async function startLiveSession({
  apiBase,
  opponent,
  teamName,
  requestId,
  getToken,
  timeoutMs = LIVE_SESSION_TIMEOUT_MS,
}: StartLiveSessionParams): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const deadline = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(new LiveSessionTimeoutError()), {
      once: true,
    });
  });

  try {
    const token = await Promise.race([getToken(), deadline]);

    return await Promise.race([
      fetch(`${apiBase}/api/live/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ opponent, teamName, requestId }),
        signal: controller.signal,
      }),
      deadline,
    ]);
  } catch (error) {
    if (timedOut || (error as Error)?.name === 'AbortError') {
      throw new LiveSessionTimeoutError();
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}