export const AUTH_REQUEST_TIMEOUT_MS = 15_000;

export class AuthRequestTimeoutError extends Error {
  readonly operation: string;

  constructor(operation: string) {
    super(
      `Sign-in timed out while ${operation}. Check your connection and try again.`,
    );
    this.name = 'AuthRequestTimeoutError';
    this.operation = operation;
  }
}

/**
 * Clerk's request promises do not expose an AbortSignal. Race them against a
 * bounded timer so a stalled native request can never leave the login UI busy
 * forever. The underlying request may finish later, but its result is ignored.
 */
export function withAuthTimeout<T>(
  promise: Promise<T>,
  operation: string,
  timeoutMs = AUTH_REQUEST_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new AuthRequestTimeoutError(operation)),
      timeoutMs,
    );

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}