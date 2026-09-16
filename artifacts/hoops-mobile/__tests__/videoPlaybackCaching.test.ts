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

  test('keeps just-saved game film processing until the proxy is ready and allows retry', () => {
    expect(gameScreen).toContain('retryAttemptsRef.current >= 12');
    expect(gameScreen).toContain('}, 5_000);');
    expect(gameScreen).toContain("streamUrlCache.delete(streamCacheKey(game.id, 'video'))");
    expect(gameScreen).toContain('testID="retry-full-game-video"');
    expect(gameScreen).toContain('Try Video Again');
    expect(gameScreen).toContain('Full Game Film is saved');
  });

  test('describes recorded highlight moments without implying the reel already exists', () => {
    expect(gameScreen).toContain('highlight moments recorded');
    expect(gameScreen).not.toContain('highlight moments ready to clip');
  });

  test('downloads native reels through the GCS-backed range proxy', () => {
    expect(gameScreen).toContain("Platform.OS !== 'web' && (type === 'highlight' || type === 'lowlight')");
    expect(gameScreen).toContain('const reelRangeProxyUrl =');
    expect(gameScreen).toContain('downloadUrl: useReelRangeProxy');
    expect(gameScreen).toContain('? (serverDownloadUrl ?? reelRangeProxyUrl)');
  });

  test('bypasses native reel HLS with the complete progressive MP4 while retaining offline downloads', () => {
    expect(gameScreen).toContain("if (result.isHls && Platform.OS !== 'web')");
    expect(gameScreen).toContain("url: result.downloadUrl");
    expect(gameScreen).toContain("setStreamIsHls(false);");
    expect(gameScreen).toContain("setSourceAttachRequest({ url: result.downloadUrl");
    expect(gameScreen).toContain("existing?.status === 'downloaded' && existing.uri");
    expect(gameScreen).toContain("setSourceAttachRequest({ url: existing.uri");
    expect(gameScreen).toContain("playbackSource(sourceAttachRequest.url, streamIsHls)");
  });

  test('saves generated reels from a verified local file instead of a remote stream URL', () => {
    expect(gameScreen).toContain('async function ensureLocalReelForSave(');
    expect(gameScreen).toContain('streamUrlCache.delete(streamCacheKey(gameId, type))');
    expect(gameScreen).toContain('url: result.downloadUrl');
    expect(gameScreen).toContain('return waitForReelDownload(gameId, type, objectPath)');
    expect(gameScreen).toContain("Platform.OS !== 'web'");
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

  test('shares the complete lowlight reel through a public link', () => {
    expect(gameScreen).toContain('async function handleShareLowlight()');
    expect(gameScreen).toContain('`${WEB_BASE}/lowlight/${shareToken}`');
    expect(gameScreen).toContain("sharingLowlight ? 'Preparing…' : 'Share Link'");
  });

  test('defaults iOS reels to the proven public web player while keeping native playback available in the same build', () => {
    expect(gameScreen).toContain("await getPublicReelUrl(gameId, 'highlight', getToken)");
    expect(gameScreen).toContain("await getPublicReelUrl(gameId, 'lowlight', getToken)");
    expect(gameScreen).toContain('await WebBrowser.openBrowserAsync(url)');
    expect(gameScreen).toContain('testID="open-highlight-web-player"');
    expect(gameScreen).toContain('testID="open-lowlight-web-player"');
    expect(gameScreen).toContain('testID="try-highlight-native-player"');
    expect(gameScreen).toContain('testID="try-lowlight-native-player"');
  });

  test('recovers from an iOS native player source error', () => {
    expect(gameScreen).toContain("player.addListener('statusChange'");
    expect(gameScreen).toContain("loadHighlightVideo(true, Platform.OS === 'ios')");
    expect(gameScreen).toContain('streamUrlCache.delete');
    expect(gameScreen).toContain('testID="retry-highlight-playback"');
  });

  test('mints a fresh range-proxy token while preserving interrupted partial bytes', () => {
    expect(gameScreen).toContain('pendingDownload?.needsUrlRefresh === true');
    expect(gameScreen).toContain('if (refreshDownloadUrl) streamUrlCache.delete');
    expect(gameScreen).toContain('forceFresh || refreshDownloadUrl');
  });

  test('automatically resumes a successfully-started local Highlight after one transient AVPlayer error', () => {
    const highlightSection = gameScreen.slice(
      gameScreen.indexOf('function HighlightSection'),
      gameScreen.indexOf('const reviewAction'),
    );
    expect(highlightSection).toContain('const interruptedLocalPlayback');
    expect(highlightSection).toContain('interruptedLocalPlayback && !automaticRetryRef.current');
    expect(highlightSection).toContain('pendingResumePositionRef.current = playbackPositionRef.current;');
    expect(highlightSection).toContain('shouldAutoPlayRef.current = true;');
    expect(highlightSection).toContain('setPlaybackLoading(true);');
    expect(highlightSection).toContain('void loadHighlightVideo();');
    expect(highlightSection).toContain("playbackInterrupted ? 'Resume Playback' : 'Retry Video'");
    expect(highlightSection).toContain('fullscreenOptions={{ enable: !usesAppFullscreen, autoExitOnRotate: false }}');
    expect(highlightSection.indexOf('<VideoView')).toBeLessThan(highlightSection.indexOf('{playbackError && !playbackLoading ? ('));
  });

  test('does not delete a completed local reel during a transient player error', () => {
    expect(gameScreen.match(/if \(signedUrl\.startsWith\('file:'\)\)/g)).toHaveLength(2);
    expect(gameScreen).toContain('void loadHighlightVideo();');
    expect(gameScreen).toContain('void loadLowlightVideo();');
    expect(gameScreen).toContain('do not call forceFresh');
  });

  test('does not recreate the highlight loader when Clerk refreshes getToken', () => {
    expect(gameScreen).toContain('const getTokenRef = useRef(getToken)');
    expect(gameScreen).toContain('const token = await getTokenRef.current()');
    expect(gameScreen).toContain('highlight?.highlightObjectPath,');
    expect(gameScreen).toContain('currentClipObjectPath,');
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

  test('commits local reel state before serialized native source attachment', () => {
    expect(gameScreen).toContain('const loadGeneration = ++loadGenerationRef.current;');
    expect(gameScreen).toContain('setSourceAttachRequest({ url: playbackUrl, id: loadGeneration })');
    expect(gameScreen).toContain('sourceAttachChainRef.current = sourceAttachChainRef.current');
    expect(gameScreen).toContain('generation !== sourceAttachGenerationRef.current');
    expect(gameScreen).not.toContain('await player.replaceAsync(playbackUrl);');
    expect(gameScreen).toContain('await player.replaceAsync(playbackSource(sourceAttachRequest.url, streamIsHls));');
  });

  test('does not replace a reel source that is already attached and playing', () => {
    expect(gameScreen).toContain('const attachedSourceRef = useRef<string | null>(null);');
    expect(gameScreen).toContain('if (attachedSourceRef.current === sourceAttachRequest.url)');
    expect(gameScreen).toContain('attachedSourceRef.current = sourceAttachRequest.url;');
  });

  test('allows an explicit retry to reattach a new file at the same local URI', () => {
    expect(gameScreen.match(/if \(forceFresh\) \{\s+attachedSourceRef\.current = null;/g)).toHaveLength(3);
    expect(gameScreen.match(/async function handleRegenerate[\s\S]*?attachedSourceRef\.current = null;/g)).toHaveLength(2);
  });

  test('declares local MP4 reels as uncached progressive video', () => {
    expect(gameScreen).toMatch(/if \(url\.startsWith\('file:'\)\) \{[\s\S]*?useCaching: false,[\s\S]*?contentType: 'progressive'/);
  });

  test('fills the reel player instead of showing black contain bars', () => {
    expect(gameScreen.match(/contentFit="cover"/g)).toHaveLength(2);
  });

  test('rejects stale reel load completions and uses the guarded resume path', () => {
    expect(gameScreen).toContain('const isCurrentLoad = () => loadGeneration === loadGenerationRef.current;');
    expect(gameScreen).toContain('if (!isCurrentLoad()) return;');
    expect(gameScreen).not.toContain('return player.replaceAsync(playbackUrl)');
  });

  test('mounts the full-game native surface before attaching its source', () => {
    expect(gameScreen).toContain('setStreamIsHls(result.isHls);');
    expect(gameScreen).toContain('setStreamUrl(result.url);');
    expect(gameScreen).not.toContain('setStreamUrl(result.url);\\n            player.replaceAsync');
    expect(gameScreen).toContain('await player.replaceAsync(playbackSource(playbackUrl, playbackIsHls));');
  });

  test('does not leave an empty black player while a reel waits for Wi-Fi', () => {
    expect(gameScreen).toContain('Waiting to download');
    expect(gameScreen).toContain('download-highlight-cellular');
    expect(gameScreen).toContain('download-lowlight-cellular');
    expect(gameScreen).toContain('The video will appear here when it is ready.');
  });

  test('does not restart reel downloads when the app backgrounds', () => {
    expect(gameScreen).not.toContain("AppState.addEventListener('change'");
  });

  test('does not let player teardown errors cancel active reel downloads', () => {
    expect(gameScreen).toContain("lowlightDownload?.status === 'downloading'");
    expect(gameScreen).toContain("highlightDownload?.status === 'downloading'");
    expect(gameScreen.match(/if \(!signedUrl \|\|/g)).toHaveLength(2);
    expect(gameScreen).toContain("forceFresh invalidates the active background download");
  });

  test('ignores empty native-player errors while a reel is still downloading', () => {
    const lowlightGuard = gameScreen.indexOf("lowlightDownload?.status === 'downloading'");
    const lowlightError = gameScreen.indexOf("setPlaybackError(error?.message ?? 'The lowlight video could not be loaded.'", lowlightGuard);
    const highlightGuard = gameScreen.indexOf("highlightDownload?.status === 'downloading'");
    const highlightError = gameScreen.indexOf("setPlaybackError(message);", highlightGuard);
    expect(lowlightGuard).toBeGreaterThan(-1);
    expect(lowlightError).toBeGreaterThan(lowlightGuard);
    expect(highlightGuard).toBeGreaterThan(-1);
    expect(highlightError).toBeGreaterThan(highlightGuard);
  });
});