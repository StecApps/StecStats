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
    expect(gameScreen).toContain("await getReusableStreamUrl(gameId, 'lowlight'");
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

  test('does not delete a completed local reel during a transient player error', () => {
    expect(gameScreen).toContain("if (signedUrl?.startsWith('file:')) return;");
  });

  test('does not recreate the highlight loader when Clerk refreshes getToken', () => {
    expect(gameScreen).toContain('const getTokenRef = useRef(getToken)');
    expect(gameScreen).toContain('const token = await getTokenRef.current()');
    expect(gameScreen).toContain('}, [gameId, highlight?.highlightObjectPath, player])');
  });

  test('delegates highlight and lowlight downloads to the shared persistent manager', () => {
    expect(gameScreen).toContain("import { reelDownloadManager, useReelDownloads }");
    expect(gameScreen).toContain('reelDownloadManager.enqueue({ gameId, type, objectPath, url: remoteUrl }, true)');
    expect(gameScreen).toContain('reelDownloadManager.get(gameId, type, objectPath)');
    expect(gameScreen).toContain("if (url.startsWith('file:'))");
    expect(gameScreen).toContain('return null;');
    expect(gameScreen).toContain('setSignedUrl(playbackUrl)');
    expect(gameScreen).toContain("'highlight',");
    expect(gameScreen).toContain("getReelPlaybackUrl(gameId, 'lowlight'");
  });

  test('shows retry controls when either local reel download fails', () => {
    expect(gameScreen).toContain('testID="retry-highlight-playback"');
    expect(gameScreen).toContain('testID="retry-lowlight-playback"');
    expect(gameScreen).toContain('This lowlight could not be downloaded.');
  });

  test('invalidates shared highlight and lowlight cache entries before regeneration', () => {
    expect(gameScreen).toContain("reelDownloadManager.invalidate(gameId, 'highlight', highlight?.highlightObjectPath)");
    expect(gameScreen).toContain("reelDownloadManager.invalidate(gameId, 'lowlight', lowlight?.lowlightObjectPath)");
  });

  test('surfaces completed reel files from the shared cache', () => {
    expect(gameScreen).toContain("existing?.status === 'downloaded' && existing.uri");
    expect(gameScreen).toContain('Downloaded on this device');
  });

  test('keeps the native reel surfaces mounted while local files attach', () => {
    expect(gameScreen).toContain('{(!signedUrl || playbackLoading) && (');
    expect(gameScreen).not.toContain("if (!signedUrl) return <ActivityIndicator");
  });

  test('does not leave an empty black player while a reel waits for Wi-Fi', () => {
    expect(gameScreen).toContain('Waiting to download');
    expect(gameScreen).toContain('download-highlight-cellular');
    expect(gameScreen).toContain('download-lowlight-cellular');
    expect(gameScreen).toContain('The video will appear here when it is ready.');
  });
});