import fs from 'node:fs';
import path from 'node:path';

const scorekeeper = fs.readFileSync(
  path.resolve(__dirname, '../app/scorekeeper.tsx'),
  'utf8',
);
const daily = fs.readFileSync(
  path.resolve(__dirname, '../lib/dailyBroadcast.ts'),
  'utf8',
);

describe('Daily cloud recording migration guards', () => {
  test('uses Daily as the camera owner for Live', () => {
    expect(scorekeeper).toContain('startDailyBroadcast');
    expect(scorekeeper).toContain('if (dailyLiveRef.current) return;');
    expect(scorekeeper).toContain('dailyLiveRef.current || dailyLive');
  });

  test('timestamps Live events from the Daily recording clock', () => {
    expect(scorekeeper).toContain('dailyRecordingElapsedMs()');
  });

  test('stops Daily before saving and imports after game creation', () => {
    expect(scorekeeper).toContain('stopDailyBroadcast()');
    expect(scorekeeper).toContain('liveSessionCode');
    expect(scorekeeper).not.toContain('onGameCreated');
  });

  test('authorizes every broadcaster join and retains the token for reconnects', () => {
    expect(scorekeeper).toContain('payload.broadcasterToken');
    expect(scorekeeper).toContain('authToken: broadcasterTokenRef.current');
    expect(scorekeeper).toContain('broadcasterTokenRef.current = null');
  });

  test('requests an actual cloud recording, not a local movie', () => {
    expect(daily).toContain("type: 'cloud'");
    expect(daily).toContain('startVideoOff: false');
    expect(daily).toContain('startAudioOff: false');
  });
});
