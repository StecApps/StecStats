import fs from 'fs';
import path from 'path';

const scorekeeper = fs.readFileSync(path.join(__dirname, '../app/scorekeeper.tsx'), 'utf8');
const gameScreen = fs.readFileSync(path.join(__dirname, '../app/game/[id].tsx'), 'utf8');
const handoff = fs.readFileSync(path.join(__dirname, '../lib/localGameVideo.ts'), 'utf8');

describe('just-saved local game film handoff', () => {
  test('remembers a single finalized native movie before navigating', () => {
    expect(scorekeeper).toContain('recordedUrisRef.current.length === 1');
    expect(scorekeeper).toContain('rememberLocalGameVideo(gameId, recordedUrisRef.current[0])');
  });

  test('plays and saves the local movie while the server proxy is processing', () => {
    expect(gameScreen).toContain('const playbackUrl = localStreamUrl ?? streamUrl');
    expect(gameScreen).toContain('proxyReady === false && !localStreamUrl');
    expect(gameScreen).toContain('proxySkipped && !localStreamUrl');
    expect(gameScreen).toContain('saveReviewVideo(playbackUrl');
  });

  test('expires stale local URI metadata', () => {
    expect(handoff).toContain('LOCAL_GAME_VIDEO_MAX_AGE_MS');
    expect(handoff).toContain('AsyncStorage.removeItem(key(gameId))');
  });
});