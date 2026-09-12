import fs from 'fs';
import path from 'path';

describe('iPad recording safeguards', () => {
  const scorekeeperPath = path.resolve(__dirname, '../app/scorekeeper.tsx');
  const source = fs.readFileSync(scorekeeperPath, 'utf8');

  test('keeps iOS capture orientation responsive to physical device rotation', () => {
    expect(source).toContain('responsiveOrientationWhenOrientationLocked');
    expect(source).toContain('!isTablet && <TouchableOpacity');
  });

  test('does not wait forever when native stopRecording hangs during camera switch', () => {
    expect(source).toContain('Promise.race([');
    expect(source).toContain('new Promise<undefined>((resolve) => setTimeout(resolve, 3_000))');
    expect(source).toContain('recordingGenerationRef.current += 1');
  });

  test('reserves the mobile camera for local recording instead of opening dual capture sessions', () => {
    expect(source).toContain('if (recordVideo) {');
    expect(source).not.toContain("Platform.OS === 'android' && recordingStartedRef.current");
    expect(source).not.toContain("Platform.OS === 'android' && webrtcStreamRef.current");
    expect(source).toContain('webrtcCameraFailedRef.current = recordVideo');
    expect(source).toContain("const cameraLandW = isTablet ? '70%' : '55%'");
    expect(source).toContain('const portraitRatio = isTablet ? 0.70');
  });

  test('keeps the native recorder stable while scoring and blocks iPad camera reconfiguration', () => {
    expect(source).toContain('const RecordingCameraPreview = React.memo');
    expect(source).toContain('videoQuality="720p"');
    expect(source).toContain('if (isRecording && isTablet) {');
    expect(source).toContain('Finish this game before switching cameras.');
    expect(source).toContain('if (webrtcCameraFailedRef.current) return;');
  });

  test('does not crop the iPad preview or background an active recording for Messages', () => {
    expect(source).toContain('style={StyleSheet.absoluteFill}');
    expect(source).not.toContain('scale > 1.01 ? { transform: [{ scale }] }');
    expect(source).toContain("if (recordingStartedRef.current) {");
    expect(source).toContain('Share the live link before you start the game clock.');
    expect(source).toContain('cameraActive={!isSharingLiveLink}');
    expect(source).toContain('if (result.action === Share.sharedAction)');
    expect(source).toContain('activateLiveBroadcast(code)');
    expect(source).toContain('Do not connect the broadcaster yet.');
    expect(source).not.toContain('url,\\n    });');
    expect(source).toContain('selectable');
    expect(source).toContain('{watchUrl(liveCode)}');
  });

  test('never presents Live modals or starts networking over an active recording', () => {
    expect(source).toContain('if (recordingStartedRef.current || isRecording) {');
    expect(source).toContain('Recording protected — finish this game before using Live.');
    expect(source).toContain('Recording protected — Live controls are locked.');
    expect(source).toContain('setShowGoLiveSheet(false);');
    expect(source).toContain('<Ionicons name="lock-closed"');
    expect(source).toContain('LIVE · REC SAFE');
  });

  test('keeps compact iPad stat controls readable and near the shooting controls', () => {
    expect(source).toContain("UNDO{'\\n'}MAKE");
    expect(source).toContain("UNDO{'\\n'}MISS");
    expect(source).toContain("justifyContent: 'flex-start'");
    expect(source).not.toContain("justifyContent: isTablet ? 'space-evenly' : 'flex-start'");
  });

  test('shares an absolute encoded public watch URL', () => {
    expect(source).toContain('const publicOrigin = API_BASE');
    expect(source).toContain('/watch/${encodeURIComponent(code)}');
    expect(source).toContain('Watch ${teamName} live: ${url}');
  });
});