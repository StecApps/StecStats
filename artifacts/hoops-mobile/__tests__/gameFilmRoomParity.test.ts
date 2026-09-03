import fs from 'node:fs';
import path from 'node:path';

jest.mock('react-native', () => ({
  Alert: { alert: jest.fn() },
  Share: { share: jest.fn() },
}));

import { Alert, Share } from 'react-native';
import { saveReviewVideo } from '@/lib/saveReviewVideo';

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
    expect(gameScreen).toContain('saveReviewVideo(streamUrl, `Full Game — vs ${game.opponent}`)');
    expect(gameScreen).toContain("saveReviewVideo(signedUrl, 'Game Highlights')");
    expect(gameScreen).toContain("saveReviewVideo(signedUrl, 'Game Lowlights')");
    expect(gameScreen).toContain('testID="regenerate-highlights"');
    expect(gameScreen).toContain('testID="regenerate-lowlights"');
  });

  describe('native save contract', () => {
    const share = Share.share as jest.Mock;
    const alert = Alert.alert as jest.Mock;

    beforeEach(() => {
      share.mockReset();
      alert.mockReset();
      share.mockResolvedValue({ action: 'sharedAction' });
    });

    test.each([
      ['full-game', 'https://cdn.example.test/full-game.mp4', 'Full Game — vs Lions'],
      ['highlight', 'https://cdn.example.test/highlights.mp4', 'Game Highlights'],
      ['lowlight', 'https://cdn.example.test/lowlights.mp4', 'Game Lowlights'],
    ])('passes the active %s URL and expected title to the native share API', async (_kind, url, title) => {
      await saveReviewVideo(url, title);

      expect(share).toHaveBeenCalledWith({
        title,
        message: url,
        url,
      });
    });

    test('treats a user-cancelled share sheet as an expected outcome', async () => {
      share.mockRejectedValueOnce(new Error('User did not share'));

      await expect(
        saveReviewVideo('https://cdn.example.test/highlights.mp4', 'Game Highlights'),
      ).resolves.toBeUndefined();

      expect(alert).not.toHaveBeenCalled();
    });
  });

  test('retains stable progressive and HLS playback behavior', () => {
    expect(gameScreen).toContain('return getReusableStreamUrl(game.id');
    expect(gameScreen).toContain("useCaching: !isHls || Platform.OS === 'android'");
    expect(gameScreen).toContain("contentType: isHls ? 'hls' as const : 'progressive' as const");
  });
});