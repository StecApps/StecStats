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
    expect(source).toContain("startMjpegFallback(code, 'camera-preview-ready')");
    expect(source).toContain('camera-state-${event.state}');
    expect(facade).toContain("return typeof nativeModule?.startMjpegAsync === 'function'");
  });

  test('bounds websocket buffering and announces the fallback mode', () => {
    expect(source).toContain('(ws.bufferedAmount ?? 0) > 512 * 1024');
    expect(source).toContain("type: 'video-frame', code, frame: event.base64");
    expect(source).toContain("broadcastVideoModeWhenJoined(code, true, 'mjpeg')");
    expect(source).toContain('HoopsCamera MJPEG did not produce a camera frame.');
    expect(source).toMatch(
      /resolveFirstFrame\(\);[\s\S]*?await startMjpegWithTimeout\(\);[\s\S]*?await Promise\.race\(\[[\s\S]*?firstFrame,[\s\S]*?mjpegFallbackActiveRef\.current = true/,
    );
    expect(source).not.toContain(
      "broadcastVideoModeWhenJoined(code, false, 'none');\n      broadcastVideoModeWhenJoined(code, true, 'mjpeg')",
    );
  });

  test('does not announce score-only while shared MJPEG startup is unresolved', () => {
    expect(source).toContain('MJPEG startup is still unresolved');
    expect(source).toContain('!pendingMode &&');
    expect(source).toContain('pendingMode?.code === code');
    expect(source).toContain('teamScore: latestScoresRef.current.teamScore');
  });

  test('finalizes recording before closing the live diagnostic channel', () => {
    expect(source).toMatch(
      /if \(recordVideo\) \{[\s\S]*?await stopMjpegFallback\(\);[\s\S]*?recordingFinishedForSaveRef\.current = resolveFinishedEvent[\s\S]*?await settleRecordingForSave\(\);[\s\S]*?broadcastClientDiagnosticWithAck\([\s\S]*?const activeLiveCode[\s\S]*?await stopLiveBroadcast\(activeLiveCode\);/,
    );
    expect(source).toContain("msg.type === 'client-diagnostic-received'");
  });

  test('bounds a never-settling native MJPEG start without stacking native retries', () => {
    expect(source).toContain('async function startMjpegWithTimeout()');
    expect(source).toContain('await Promise.race([');
    expect(source).toContain("reject(new Error('HoopsCamera MJPEG start timed out.'))");
    expect(source).toContain('await startMjpegWithTimeout()');
    expect(source).toContain('fallbackGeneration !== mjpegFallbackGenerationRef.current');
    expect(source).toContain("broadcastVideoModeWhenJoined(code, false, 'none')");
    expect(source).toContain('Never stack retries on the AVFoundation path');
    expect(source).not.toContain('attempt < 3');
    expect(source).not.toContain('attempt + 1');
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