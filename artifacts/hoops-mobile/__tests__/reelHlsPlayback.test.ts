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

describe('native reel playback when the server advertises HLS', () => {
  test('does not route an HLS download update into segmented Highlight loading', () => {
    expect(highlightSection).toContain('if (usesSegmentedPlayback) {');
    expect(highlightSection).not.toContain('if (usesSegmentedPlayback || streamIsHls) {');
  });

  test('plays the complete progressive MP4 instead of the failing Highlight playlist', () => {
    expect(highlightSection).toContain("if (result.isHls && Platform.OS !== 'web')");
    expect(highlightSection).toContain('setStreamIsHls(false);');
    expect(highlightSection).toContain('setSignedUrl(result.downloadUrl);');
    expect(highlightSection).toContain('setSourceAttachRequest({ url: result.downloadUrl');
  });

  test('plays the complete progressive MP4 instead of the failing Lowlight playlist', () => {
    expect(lowlightSection).toContain("if (result.isHls && Platform.OS !== 'web')");
    expect(lowlightSection).toContain('setStreamIsHls(false);');
    expect(lowlightSection).toContain('setSignedUrl(result.downloadUrl);');
    expect(lowlightSection).toContain('setSourceAttachRequest({ url: result.downloadUrl');
  });

  test('retains the complete MP4 download for offline Save', () => {
    expect(lowlightSection).toContain('await waitForReelDownload');
    expect(highlightSection).toContain('await waitForReelDownload');
  });
});