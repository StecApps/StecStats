import fs from 'fs';
import path from 'path';

describe('iPad recording safeguards', () => {
  const scorekeeperPath = path.resolve(__dirname, '../app/scorekeeper.tsx');
  const source = fs.readFileSync(scorekeeperPath, 'utf8');
  const nativeCameraSource = fs.readFileSync(
    path.resolve(__dirname, '../modules/hoops-camera/ios/HoopsCameraSession.swift'),
    'utf8',
  );
  const packageConfig = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'),
  );
  const appConfig = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../app.json'), 'utf8'),
  );

  test('keeps iOS capture orientation responsive to physical device rotation', () => {
    expect(source).toContain('responsiveOrientationWhenOrientationLocked');
    expect(source).toContain('!isTablet && <TouchableOpacity');
  });

  test('does not wait forever when native stopRecording hangs during camera switch', () => {
    expect(source).toContain('Promise.race([');
    expect(source).toContain('new Promise<undefined>((resolve) => setTimeout(resolve, 3_000))');
    expect(source).toContain('watchdog is feedback only');
    expect(source).toContain('camera switch will continue when the clip is safe.');
    expect(source).not.toContain('recordingCompletionRef.current?.resolve(result)');
    expect(source).toContain('recordingGenerationRef.current += 1');
    expect(source).toContain('recordingPromiseRef.current = completion');
    expect(source).toContain('startHoopsCameraRecordingAsync(micMuted)');
    expect(source).not.toContain('could not apply recording mute');
  });

  test('shares the compiled iOS camera pipeline while preserving old-binary fallback', () => {
    expect(source).toContain('if (recordVideo) {');
    expect(source).not.toContain("Platform.OS === 'android' && recordingStartedRef.current");
    expect(source).not.toContain("Platform.OS === 'android' && webrtcStreamRef.current");
    expect(source).toContain('recordVideo && !sharedCameraMode');
    expect(source).toContain('createHoopsCameraLiveVideoAsync');
    expect(source).toContain('releaseHoopsCameraLiveVideoAsync');
    expect(source).toContain('if (webrtcStreamRef.current && !sharedCameraMode)');
    expect(source).toContain('getUserMedia({ audio: true, video: false })');
    expect(source).toContain('Do not call getUserMedia with video');
    expect(source).toContain('liveMediaGenerationRef');
    expect(source).toContain('liveSessionGenerationRef');
    expect(source).toContain('if (!isCurrentSession()) return;');
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

  test('provides bounded recording zoom controls with a gentler pinch response', () => {
    expect(source).toContain('const [cameraZoom, setCameraZoom] = useState(0)');
    expect(source).toContain('const CAMERA_ZOOM_STEP = 0.05');
    expect(source).toContain('const CAMERA_PINCH_SENSITIVITY = 0.2');
    expect(source).toContain('testID="camera-zoom-out"');
    expect(source).toContain('testID="camera-zoom-in"');
    expect(source).toContain('disabled={cameraZoom <= 0}');
    expect(source).toContain('disabled={cameraZoom >= 1}');
    expect(source).toContain('adjustCameraZoom(-CAMERA_ZOOM_STEP)');
    expect(source).toContain('adjustCameraZoom(CAMERA_ZOOM_STEP)');
    expect(source).toContain('pinchBaseZoom.value + (e.scale - 1) * CAMERA_PINCH_SENSITIVITY');
    expect(nativeCameraSource).toContain('min(device.activeFormat.videoMaxZoomFactor, 5)');
  });

  test('does not crop the iPad preview or background an active recording for Messages', () => {
    expect(source).toContain('style={StyleSheet.absoluteFill}');
    expect(source).not.toContain('scale > 1.01 ? { transform: [{ scale }] }');
    expect(source).toContain("if (recordingStartedRef.current || isRecording) {");
    expect(source).toContain('Share the live link before you start the game clock.');
    expect(source).toContain('cameraActive={!isSharingLiveLink || recordingStartedRef.current || isRecording}');
    expect(source).toContain('if (result.action === Share.sharedAction)');
    expect(source).toContain('activateLiveBroadcast(code)');
    expect(source).not.toContain('scheduleIdleCameraRecovery');
    expect(source).not.toContain("AppState.addEventListener('change'");
    expect(source).not.toContain('key={cameraRecoveryKey}');
    expect(source).not.toContain('expo-screen-orientation');
    expect(source).not.toContain('ScreenOrientation.lockAsync');
    expect(source).toContain('Do not connect the broadcaster yet.');
    expect(source).not.toContain('url,\\n    });');
    expect(source).toContain('selectable');
    expect(source).toContain('{watchUrl(liveCode)}');
  });

  test('starts shared live video in place without presenting a modal over recording', () => {
    expect(source).toContain('if ((recordingStartedRef.current || isRecording) && !sharedCameraMode) {');
    expect(source).toContain('Recording protected — finish this game before using Live.');
    expect(source).toContain('Recording protected — Live controls are locked.');
    expect(source).toContain('activateLiveBroadcast(code);');
    expect(source).toContain('Live video started — recording is still protected.');
    expect(source).toContain('Live video is active. Share the link after recording.');
    expect(source).toContain('setShowGoLiveSheet(false);');
    expect(source).toContain('<Ionicons name="lock-closed"');
    expect(source).toContain('LIVE · REC SAFE');
  });

  test('enables the single-session shared native camera only in the isolated runtime', () => {
    expect(source).toContain('const ENABLE_SHARED_CAMERA_MODE = true');
    expect(source).toContain('ENABLE_SHARED_CAMERA_MODE &&');
    expect(packageConfig.expo.autolinking.exclude).toBeUndefined();
    expect(packageConfig.dependencies).not.toHaveProperty('expo-screen-orientation');
    expect(appConfig.expo.runtimeVersion).toBe('1.0.0-shared-camera-20260929');
    expect(appConfig.expo.ios.buildNumber).toBe('20260931');
  });

  test('keeps compact iPad stat controls readable and near the shooting controls', () => {
    expect(source).toContain("UNDO{'\\n'}MAKE");
    expect(source).toContain("UNDO{'\\n'}MISS");
    expect(source).toContain("justifyContent: isTabletLandscape ? 'space-evenly' : 'flex-start'");
    expect(source).not.toContain("justifyContent: isTablet ? 'space-evenly' : 'flex-start'");
  });

  test('shares an absolute encoded public watch URL', () => {
    expect(source).toContain('const publicOrigin = API_BASE');
    expect(source).toContain('/watch/${encodeURIComponent(code)}');
    expect(source).toContain('Watch ${teamName} live: ${url}');
  });

  test('shows a prominent Start Game action after sharing before gameplay begins', () => {
    expect(source).toContain('const hasGameActivity =');
    expect(source).toContain('testID="start-game-footer"');
    expect(source).toContain('<Text style={styles.saveBtnText}>Start Game</Text>');
    expect(source).toContain(') : !hasGameActivity ? (');
  });
});