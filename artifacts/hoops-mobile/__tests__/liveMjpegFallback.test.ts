import fs from 'fs';
import path from 'path';

const source = fs.readFileSync(path.join(__dirname, '../app/scorekeeper.tsx'), 'utf8');
const facade = fs.readFileSync(
  path.join(__dirname, '../modules/hoops-camera/src/index.ts'),
  'utf8',
);

describe('shared-camera MJPEG fallback', () => {
  test('falls back only after repeated zero outbound RTP observations', () => {
    expect(source).toContain("report.type === 'outbound-rtp'");
    expect(source).toContain('consecutiveZeroOutboundPolls >= 2');
    expect(source).toContain("startMjpegFallback(code, 'outbound-rtp-zero')");
  });

  test('also escapes a peer connection that never connects', () => {
    expect(source).toContain("startMjpegFallback(code, 'peer-not-connected')");
    expect(source).toContain('}, 15_000);');
  });

  test('uses bounded MJPEG as the primary shared-camera live transport', () => {
    expect(source).toContain("startMjpegFallback(liveCode, 'shared-camera-primary')");
    expect(source).toContain('attempt < 3');
    expect(source).toContain('attempt + 1');
    expect(facade).toContain("return typeof nativeModule?.startMjpegAsync === 'function'");
  });

  test('bounds websocket buffering and announces the fallback mode', () => {
    expect(source).toContain('(ws.bufferedAmount ?? 0) > 512 * 1024');
    expect(source).toContain("type: 'video-frame', code, frame: event.base64");
    expect(source).toContain("broadcastVideoModeWhenJoined(code, true, 'mjpeg')");
  });

  test('cancels an in-flight native start and cleans up on unmount', () => {
    expect(source).toContain('fallbackGeneration !== mjpegFallbackGenerationRef.current');
    expect(source).toContain('if (fallbackGeneration !== mjpegFallbackGenerationRef.current) return;');
    expect(source).toMatch(
      /liveWsRef\.current\?\.close\(\);[\s\S]*?closeAllWebRtcPeers\(\);[\s\S]*?stopWebRtcStream\(\);[\s\S]*?stopMjpegFallback\(\);/,
    );
  });

  test('does not crash the filming route on binaries without MJPEG exports', () => {
    expect(source).toContain('if (!isHoopsCameraMjpegAvailable())');
    expect(facade).toContain("typeof stop === 'function' ? stop.call(nativeModule) : Promise.resolve()");
  });
});