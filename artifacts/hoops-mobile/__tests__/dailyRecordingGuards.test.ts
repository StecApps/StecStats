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
    expect(scorekeeper).toContain('recordVideo && !dailyLive && !cameraReady');
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

  test('starts YouTube distribution only after Daily joins and rolls back on failure', () => {
    expect(scorekeeper).toContain('/youtube/start');
    expect(scorekeeper).toContain('await startDailyBroadcast(daily)');
    expect(scorekeeper).toContain('await stopLiveBroadcast(code)');
    expect(scorekeeper).toContain('YOUTUBE_NOT_CONNECTED');
    expect(scorekeeper).toContain('YOUTUBE_RECONNECT_REQUIRED');
    expect(scorekeeper).toContain('YOUTUBE_LIVE_NOT_ENABLED');
    expect(scorekeeper).toContain('First activation may take up to 24 hours');
  });

  test('keeps the public StecStats watch link instead of exposing YouTube details', () => {
    expect(scorekeeper).toContain('unlisted YouTube stream');
    expect(scorekeeper).toContain('without an account');
    expect(scorekeeper).toContain('videoId/watchUrl are intentionally not exposed');
  });

  test('stops server YouTube distribution before leaving Daily and coalesces duplicate stops', () => {
    const serverStop = scorekeeper.indexOf('/api/live/${encodeURIComponent(code)}/stop');
    const dailyStop = scorekeeper.indexOf('stopDailyBroadcast().catch', serverStop);
    expect(serverStop).toBeGreaterThan(-1);
    expect(dailyStop).toBeGreaterThan(serverStop);
    expect(scorekeeper).toContain('liveStopPromiseRef.current');
    expect(scorekeeper).toContain('Live stop needs retry');
    expect(scorekeeper).toContain('dailyRecordingRef.current = await stopDailyBroadcast().catch(() => null)');
  });

  test('requests an actual cloud recording, not a local movie', () => {
    expect(daily).toContain("type: 'cloud'");
    expect(daily).toContain('startVideoOff: false');
    expect(daily).toContain('startAudioOff: false');
  });
});
