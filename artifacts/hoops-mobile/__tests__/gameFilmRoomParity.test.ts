import fs from 'node:fs';
import path from 'node:path';

const gameScreen = fs.readFileSync(
  path.resolve(__dirname, '../app/game/[id].tsx'),
  'utf8',
);

describe('mobile game-video parity', () => {
  test('filters Film Room events by player and event category', () => {
    expect(gameScreen).toContain('activePlayerId');
    expect(gameScreen).toContain('activeCategory');
    expect(gameScreen).toContain('film-room-player-all');
    expect(gameScreen).toContain('film-room-category-${category.key}');
  });

  test('maps recorded event timestamps onto the repaired video timeline', () => {
    expect(gameScreen).toContain('game.videoOffsetMs ?? 0');
    expect(gameScreen).toContain('timestampMs >= game.videoHalf2StartMs');
    expect(gameScreen).toContain('game.videoHalftimeGapMs');
  });

  test('lets coaches jump from timeline markers and event rows', () => {
    expect(gameScreen).toContain('testID="film-room-timeline"');
    expect(gameScreen).toContain('player.currentTime = Math.max(0, toVideoSeconds(event.videoTimestampMs) - 8)');
    expect(gameScreen).toContain('player.play()');
  });

  test('offers native save and reel-regeneration actions', () => {
    expect(gameScreen).toContain('testID="save-full-game"');
    expect(gameScreen).toContain('testID="save-highlight-video"');
    expect(gameScreen).toContain('testID="save-lowlight-video"');
    expect(gameScreen).toContain('testID="regenerate-highlights"');
    expect(gameScreen).toContain('testID="regenerate-lowlights"');
  });

  test('retains stable progressive and HLS playback behavior', () => {
    expect(gameScreen).toContain('return getReusableStreamUrl(game.id');
    expect(gameScreen).toContain("useCaching: !isHls || Platform.OS === 'android'");
    expect(gameScreen).toContain("contentType: isHls ? 'hls' as const : 'progressive' as const");
  });
});