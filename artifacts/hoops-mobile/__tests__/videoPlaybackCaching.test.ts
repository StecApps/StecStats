import fs from 'node:fs';
import path from 'node:path';

const gameScreen = fs.readFileSync(
  path.resolve(__dirname, '../app/game/[id].tsx'),
  'utf8',
);

describe('saved-video playback caching', () => {
  test('keeps progressive game media in Expo Video native cache', () => {
    expect(gameScreen).toContain("useCaching: !isHls || Platform.OS === 'android'");
    expect(gameScreen).toContain("contentType: isHls ? 'hls' as const : 'progressive' as const");
  });

  test('reuses the same signed URL so buffered ranges remain addressable', () => {
    expect(gameScreen).toContain('const streamUrlCache = new Map<string, CachedStream>()');
    expect(gameScreen).toContain('return getReusableStreamUrl(game.id');
    expect(gameScreen).toContain("return getReusableStreamUrl(gameId, 'highlight'");
    expect(gameScreen).toContain("return getReusableStreamUrl(gameId, 'lowlight'");
  });

  test('uses a larger LRU cache and a forward buffer for full games', () => {
    expect(gameScreen).toContain('setVideoCacheSizeAsync(3 * 1024 * 1024 * 1024)');
    expect(gameScreen).toContain('preferredForwardBufferDuration: 60');
    expect(gameScreen).toContain('waitsToMinimizeStalling: true');
  });
});