import fs from 'node:fs';
import path from 'node:path';

const gameScreen = fs.readFileSync(
  path.resolve(__dirname, '../app/game/[id].tsx'),
  'utf8',
);

describe('saved-video playback caching', () => {
  test('keeps progressive game media in Expo Video native cache', () => {
    expect(gameScreen).toContain("useCaching: allowCaching && (!isHls || Platform.OS === 'android')");
    expect(gameScreen).toContain("contentType: isHls ? 'hls' as const : 'progressive' as const");
  });

  test('reuses the same signed URL so buffered ranges remain addressable', () => {
    expect(gameScreen).toContain('const streamUrlCache = new Map<string, CachedStream>()');
    expect(gameScreen).toContain('return getReusableStreamUrl(game.id');
    expect(gameScreen).toContain("await getReusableStreamUrl(gameId, 'highlight'");
    expect(gameScreen).toContain("return getReusableStreamUrl(gameId, 'lowlight'");
  });

  test('uses a larger LRU cache and a forward buffer for full games', () => {
    expect(gameScreen).toContain('setVideoCacheSizeAsync(3 * 1024 * 1024 * 1024)');
    expect(gameScreen).toContain('preferredForwardBufferDuration: 60');
    expect(gameScreen).toContain('waitsToMinimizeStalling: true');
  });

  test('shows a paused full-frame player with native playback controls', () => {
    expect(gameScreen).toContain('contentFit="contain"');
    expect(gameScreen).toMatch(/allowsPictureInPicture\s+nativeControls/);
  });

  test('shares highlight clips without requiring YouTube', () => {
    expect(gameScreen).toContain('async function handleShareClip()');
    expect(gameScreen).toContain('`${WEB_BASE}/highlight/${shareToken}`');
    expect(gameScreen).toContain("sharingClip ? 'Preparing…' : 'Share Clip'");
  });

  test('recovers from an iOS native player source error', () => {
    expect(gameScreen).toContain("player.addListener('statusChange'");
    expect(gameScreen).toContain("loadHighlightVideo(true, Platform.OS === 'ios')");
    expect(gameScreen).toContain('streamUrlCache.delete');
    expect(gameScreen).toContain('testID="retry-highlight-playback"');
  });

  test('does not recreate the highlight loader when Clerk refreshes getToken', () => {
    expect(gameScreen).toContain('const getTokenRef = useRef(getToken)');
    expect(gameScreen).toContain('const token = await getTokenRef.current()');
    expect(gameScreen).toContain('}, [gameId, player])');
  });

  test('plays highlight and lowlight reels through the stable ranged API stream', () => {
    expect(gameScreen).toContain("type === 'highlight' || type === 'lowlight'");
    expect(gameScreen).toContain("stream/${type}?t=${streamToken}&proxy=1");
  });
});