import fs from 'node:fs';
import path from 'node:path';

const gameScreen = fs.readFileSync(
  path.resolve(__dirname, '../app/game/[id].tsx'),
  'utf8',
);
const lowlightSection = gameScreen.slice(
  gameScreen.indexOf('function LowlightSection'),
  gameScreen.indexOf('function HighlightSection'),
);
const highlightSection = gameScreen.slice(
  gameScreen.indexOf('function HighlightSection'),
  gameScreen.indexOf('const reviewAction'),
);

describe('native reel HLS playback', () => {
  test('does not route an HLS download update into segmented Highlight loading', () => {
    expect(highlightSection).toContain('if (usesSegmentedPlayback) {');
    expect(highlightSection).not.toContain('if (usesSegmentedPlayback || streamIsHls) {');
  });

  test('keeps iPhone Highlight HLS out of AVPlayerViewController fullscreen', () => {
    expect(highlightSection).toContain(
      "Platform.OS === 'ios' && (usesSegmentedPlayback || streamIsHls)",
    );
    expect(highlightSection).toContain(
      'fullscreenOptions={{ enable: !usesAppFullscreen, autoExitOnRotate: false }}',
    );
    expect(highlightSection).toContain(
      '{usesAppFullscreen && segmentedFullscreenVisible && (',
    );
  });

  test('keeps iPhone Lowlight HLS on one mutually exclusive app-owned surface', () => {
    expect(lowlightSection).toContain(
      "const usesAppFullscreen = Platform.OS === 'ios' && streamIsHls",
    );
    expect(lowlightSection).toContain('{!fullscreenVisible && <VideoView');
    expect(lowlightSection).toContain('{usesAppFullscreen && fullscreenVisible && (');
    expect(lowlightSection).toContain('testID="lowlight-modal"');
    expect(lowlightSection).toContain('fullscreenOptions={{ enable: false }}');
  });

  test('retains the complete MP4 path for Save while HLS is playing', () => {
    expect(lowlightSection).toContain('await waitForReelDownload');
    expect(highlightSection).toContain('await waitForReelDownload');
  });
});