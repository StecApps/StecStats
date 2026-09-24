import * as FileSystem from 'expo-file-system/legacy';

// A complete local proxy avoids iOS AVPlayer's unreliable remote Range seeks.
// Keep these files in the OS-managed cache, not alongside the original recording.
const inFlight = new Map<string, Promise<string>>();

function fingerprint(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export async function getSeekableGameFilm(gameId: number, proxyIdentity: string, url: string): Promise<string> {
  if (!FileSystem.cacheDirectory) throw new Error('Video storage is unavailable on this device.');
  const identity = `${gameId}:${proxyIdentity}`;
  const existing = inFlight.get(identity);
  if (existing) return existing;

  const request = (async () => {
    const directory = `${FileSystem.cacheDirectory}seekable-game-film/`;
    const destination = `${directory}${gameId}-${fingerprint(proxyIdentity)}.mp4`;
    const partial = `${destination}.partial`;
    await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
    const cached = await FileSystem.getInfoAsync(destination);
    if (cached.exists && (cached.size ?? 0) > 1024) return destination;

    await FileSystem.deleteAsync(partial, { idempotent: true });
    try {
      const result = await FileSystem.downloadAsync(url, partial);
      if (result.status !== 200) throw new Error(`Video download failed (${result.status}).`);
      const info = await FileSystem.getInfoAsync(partial);
      const contentLength = Object.entries(result.headers).find(([name]) => name.toLowerCase() === 'content-length')?.[1];
      if (!info.exists || (info.size ?? 0) <= 1024 ||
          (contentLength && info.size !== Number(contentLength))) {
        throw new Error('The film download was incomplete.');
      }
      await FileSystem.moveAsync({ from: partial, to: destination });
      return destination;
    } catch (error) {
      await FileSystem.deleteAsync(partial, { idempotent: true }).catch(() => {});
      throw error;
    }
  })();
  inFlight.set(identity, request);
  try {
    return await request;
  } finally {
    inFlight.delete(identity);
  }
}

export function isSeekableGameFilm(uri: string) {
  return !!FileSystem.cacheDirectory &&
    uri.startsWith(`${FileSystem.cacheDirectory}seekable-game-film/`);
}

export async function forgetSeekableGameFilm(uri: string) {
  if (isSeekableGameFilm(uri)) {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  }
}