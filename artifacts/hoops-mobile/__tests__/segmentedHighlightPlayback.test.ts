import fs from 'node:fs';
import path from 'node:path';

const gameScreen = fs.readFileSync(
  path.resolve(__dirname, '../app/game/[id].tsx'),
  'utf8',
);
const highlightSection = gameScreen.slice(
  gameScreen.indexOf('function HighlightSection'),
  gameScreen.indexOf('const reviewAction'),
);

describe('segmented iOS Highlight playback', () => {
  test('prefers the continuous combined reel while retaining segmented fallback code', () => {
    expect(highlightSection).toContain('const enableSegmentedIosHighlights = false');
    expect(highlightSection).toContain('enableSegmentedIosHighlights &&');
    expect(highlightSection).toContain("Platform.OS === 'ios'");
    expect(highlightSection).toContain('highlight?.playbackVersion === 1');
    expect(highlightSection).toContain('segmentedClips.length > 0');
  });

  test('uses stable unsigned clip identities and attaches local files only', () => {
    expect(gameScreen).toContain('function unsignedStreamIdentity(streamUrl: string)');
    expect(gameScreen).toContain('`${parsed.origin}${parsed.pathname}`');
    expect(highlightSection).toContain('highlightClipIdentity(currentClip.index, currentClip.streamUrl)');
    expect(highlightSection).toContain("existing?.status === 'downloaded' && existing.uri");
    expect(highlightSection).toContain('setSourceAttachRequest({ url: existing.uri');
    expect(highlightSection).not.toContain('setSourceAttachRequest({ url: currentClip.streamUrl');
  });

  test('advances in manifest order on playToEnd or the validated duration fallback', () => {
    expect(highlightSection).toContain('.sort((a, b) => a.index - b.index)');
    expect(highlightSection).toContain("player.addListener('playToEnd'");
    expect(highlightSection).toContain('const advanceSegmentedClip = () =>');
    expect(highlightSection).toContain('const expectedEnd = (currentClip?.durationMs ?? 0) / 1000');
    expect(highlightSection).toContain('currentTime >= expectedEnd - 0.15');
    expect(highlightSection).toContain('player.currentTime >= expectedEnd - 0.35');
    expect(highlightSection).toContain('setCurrentClipPosition((position) => position + 1)');
    expect(highlightSection).toContain('shouldAutoPlayRef.current = true');
  });

  test('prefetches the next standalone clip only after playback starts', () => {
    const playingListener = highlightSection.slice(
      highlightSection.indexOf("player.addListener('playingChange'"),
      highlightSection.indexOf("player.addListener('playToEnd'"),
    );
    expect(playingListener).toContain('if (isPlaying)');
    expect(playingListener).toContain('segmentedClips[currentClipPosition + 1]');
    expect(playingListener).toContain('reelDownloadManager.enqueue');
  });

  test('retains combined-reel loading as the legacy fallback and save source', () => {
    expect(highlightSection).toContain("await getReusableStreamUrl(gameId, 'highlight', token)");
    expect(highlightSection).toContain('const objectPath = highlight?.highlightObjectPath');
    expect(highlightSection).toContain('saveUrl = await waitForReelDownload');
  });

  test('uses mutually exclusive inline/modal surfaces and disables native fullscreen', () => {
    expect(highlightSection).toContain('testID="expand-segmented-highlight"');
    expect(highlightSection).toContain('testID="segmented-highlight-modal"');
    expect(highlightSection).toContain('fullscreenOptions={{ enable: !usesAppFullscreen');
    expect(highlightSection).toContain('fullscreenOptions={{ enable: false }}');
    expect(highlightSection).toContain('Clip {currentClipPosition + 1} of {segmentedClips.length}');
    expect(highlightSection).toContain('testID="close-segmented-highlight"');
    expect(highlightSection).toContain('{!segmentedFullscreenVisible && <VideoView');
    expect(highlightSection).toContain('{usesAppFullscreen && segmentedFullscreenVisible && (');
    expect(highlightSection).not.toContain('visible={segmentedFullscreenVisible}');

    const inlineBranch = highlightSection.indexOf('{!segmentedFullscreenVisible && <VideoView');
    const modalBranch = highlightSection.indexOf('{usesAppFullscreen && segmentedFullscreenVisible && (');
    expect(inlineBranch).toBeGreaterThan(-1);
    expect(modalBranch).toBeGreaterThan(inlineBranch);
  });
});