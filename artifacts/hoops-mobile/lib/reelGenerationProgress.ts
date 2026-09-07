export function resolveGenerationStartedAtMs(
  serverStartedAt: unknown,
  existingStartedAtMs: number | undefined,
  nowMs: number = Date.now(),
): number {
  const parsedMs =
    serverStartedAt instanceof Date
      ? serverStartedAt.getTime()
      : typeof serverStartedAt === 'string' || typeof serverStartedAt === 'number'
        ? new Date(serverStartedAt).getTime()
        : Number.NaN;

  if (Number.isFinite(parsedMs)) {
    // Clamp small device/server clock differences so progress never becomes
    // negative while still preserving the server-owned generation timestamp.
    return Math.min(parsedMs, nowMs);
  }

  return existingStartedAtMs ?? nowMs;
}

export function getGenerationElapsedSec(
  startedAtMs: number,
  nowMs: number = Date.now(),
): number {
  return Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
}