import fs from 'fs';
import path from 'path';

describe('iPad recording safeguards', () => {
  const scorekeeperPath = path.resolve(__dirname, '../app/scorekeeper.tsx');
  const source = fs.readFileSync(scorekeeperPath, 'utf8');
  const nativeCameraSource = fs.readFileSync(
    path.resolve(__dirname, '../modules/hoops-camera/ios/HoopsCameraSession.swift'),
    'utf8',
  );
  const nativeFacadeSource = fs.readFileSync(
    path.resolve(__dirname, '../modules/hoops-camera/src/index.ts'),
    'utf8',
  );
  const nativeMjpegSource = fs.readFileSync(
    path.resolve(__dirname, '../modules/hoops-camera/ios/HoopsCameraMjpegFrameProducer.swift'),
    'utf8',
  );
  const webRtcPatchSource = fs.readFileSync(
    path.resolve(__dirname, '../../../patches/react-native-webrtc@124.0.8.patch'),
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
    expect(nativeCameraSource).toContain('UIApplication.didBecomeActiveNotification');
    expect(nativeCameraSource).toContain('self.scheduleLifecycleResume()');
    expect(nativeCameraSource).toContain('DispatchQueue.main.asyncAfter(deadline: .now() + 0.35)');
    expect(nativeCameraSource).toContain('UIApplication.shared.applicationState == .active');
    expect(nativeCameraSource).toContain('generation == lifecycleGeneration');
  });

  test('recovers lifecycle recording through native interruption and resume events', () => {
    expect(nativeCameraSource).toContain('lifecycleInterruptionID');
    expect(nativeCameraSource).toContain('recordingStopReason = "lifecycle"');
    expect(nativeCameraSource).toContain('AVErrorRecordingSuccessfullyFinishedKey');
    expect(nativeCameraSource).toContain('if stopReason == "lifecycle"');
    expect(nativeCameraSource).toContain('"onLifecycleResume"');
    expect(nativeCameraSource).toContain('"interruptionId"');
    expect(nativeCameraSource).toContain('"timestampMs"');
    expect(nativeCameraSource).toContain('"finalizedUri"');
    expect(nativeCameraSource).toContain('"interruptedAtMs"');
    expect(nativeCameraSource).toContain('self.completeLifecycleResume(generation: generation)');
    expect(nativeCameraSource).toContain('!lifecycleFinalizationComplete');
    expect(source).toContain('event.timestampMs');
    expect(source).toContain('addRecordedUri(event.finalizedUri)');
    expect(source).toContain('event.interruptedAtMs');
    expect(source).toContain("addHoopsCameraListener('onStateChange'");
    expect(source).toContain("addHoopsCameraListener('onRecordingFinished'");
    expect(source).toContain("addHoopsCameraListener('onLifecycleResume'");
    expect(source).toContain('recordingTerminalIntentRef.current');
    expect(source).toContain('settleRecordingForSave');
    expect(source).toContain('recordedUrisRef.current.includes(uri)');
    expect(source).toContain('setUploadRetryGeneration((generation) => generation + 1)');
    expect(source).toContain('handledUploadRetryGenerationRef.current = uploadRetryGeneration');
    expect(source).toContain('void retryFinalizedSave()');
    expect(source).toContain('await saveWithPendingMasterLease()');
    expect(source).toContain('Recording is still finishing');
    expect(source).not.toContain('recordingCompletionRef.current?.resolve({ uri: event.uri })');
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
    expect(source).toContain('waitForHoopsCameraLiveVideoFramesAsync');
    expect(source).toContain('releaseHoopsCameraLiveVideoAsync');
    expect(source).toContain('if (webrtcStreamRef.current && !sharedCameraMode)');
    expect(source).toContain('getUserMedia({ audio: true, video: false })');
    expect(source).toContain('Do not call getUserMedia with video');
    expect(source).toContain('liveMediaGenerationRef');
    expect(source).toContain('liveSessionGenerationRef');
    expect(source).toContain('if (!isCurrentSession()) return;');
    expect(source).toContain("const cameraLandW = isTablet ? '62%' : '55%'");
    expect(source).toContain('const portraitRatio = isTablet ? 0.70');
    expect(source).toContain('setLiveMediaRecoveryGeneration((generation) => generation + 1)');
    expect(source).toContain("videoMode: 'webrtc' | 'mjpeg' | 'none'");
    expect(source).toContain("if (msg.type === 'broadcaster-joined')");
    expect(source).toContain('broadcastVideoModeWhenJoined(liveCode, true)');
    expect(source).toContain('pendingVideoModeRef.current = { code, hasVideo, videoMode }');
  });

  test('keeps the native recorder stable while scoring and blocks iPad camera reconfiguration', () => {
    expect(source).toContain('const RecordingCameraPreview = React.memo');
    expect(source).toContain('videoQuality="720p"');
    expect(source).toContain('if (isRecording && isTablet) {');
    expect(source).toContain('Finish this game before switching cameras.');
    expect(source).toContain('if (webrtcCameraFailedRef.current) return;');
  });

  test('keeps landscape iPad stats-only games in the full-width layout', () => {
    expect(source).toContain('recordVideo && isLandscape && styles.rootLandscape');
    expect(source).toContain('recordVideo && isLandscape && styles.statsSectionLand');
    expect(source).not.toContain('style={[styles.root, isLandscape && styles.rootLandscape]}');
    expect(source).not.toContain('style={[styles.statsSection, isLandscape && styles.statsSectionLand]}');
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
    expect(nativeCameraSource).toContain('kCVPixelFormatType_420YpCbCr8BiPlanarFullRange');
  });

  test('retains an unexpectedly finalized recording and closes its timeline', () => {
    expect(source).toContain('const result = await recordingPromiseRef.current');
    expect(source).toContain('addRecordedUri(result?.uri)');
    expect(source).toContain('if (!sharedCameraMode) {');
    expect(source).toContain('stopVideoTimelineSegment(videoTimelineClockRef.current, event.timestampMs)');
    expect(nativeCameraSource).toContain('AVCaptureSession.wasInterruptedNotification');
    expect(nativeCameraSource).toContain('AVCaptureSession.runtimeErrorNotification');
    expect(nativeCameraSource).toContain('private var recordingFinalizationInFlight = false');
    expect(nativeCameraSource).toContain('private var recoveryRestartPending = false');
    expect(nativeCameraSource).toContain('self.attemptPendingCaptureRecovery(reason: "session-interruption-ended")');
    expect(nativeCameraSource).toContain('!recordingFinalizationInFlight');
    expect(nativeCameraSource).toContain('isPreviewAttached');
    expect(nativeCameraSource).toContain('isPreviewActive');
    expect(nativeCameraSource).toContain('UIApplication.shared.applicationState == .active');
    expect(nativeCameraSource).toContain('self.recoveryRestartPending = false');
    expect(nativeCameraSource).toContain('private let recoveryIntentLock = NSLock()');
    expect(nativeCameraSource).toContain('setAutomaticRecoverySuppressed(true)');
    expect(nativeCameraSource).toContain('setAutomaticRecoverySuppressed(false)');
    expect(nativeCameraSource).toContain('!isAutomaticRecoverySuppressed()');
    expect(nativeCameraSource).toContain('self.sessionQueue.async {');
    expect(nativeCameraSource).toContain('self.attemptPendingCaptureRecovery(reason: "recording-finalized-recovery")');
    expect(nativeCameraSource).toContain('if self.movieOutput.isRecording');
    expect(nativeCameraSource).toContain('self.movieOutput.stopRecording()');
    expect(nativeCameraSource).toContain('didStartRecordingTo fileURL');
    expect(nativeCameraSource).toContain('let resolvedStopReason = stopReason ?? "unexpected"');
    expect(nativeCameraSource).toContain('guard self.session.isRunning else');
    expect(nativeCameraSource).toContain('fileSize > 16_384');
    expect(nativeCameraSource).toContain('hasVideoTrack');
    expect(nativeCameraSource).toContain('"usable": hasUsableCheckpoint');
    expect(nativeCameraSource).toContain('"durationSeconds": durationSeconds.isFinite');
    expect(source).toContain("broadcastClientDiagnostic('recording-finished'");
    expect(source).toContain("event.reason?.startsWith('session-interruption-')");
    expect(source).toContain('if (wasRunning) pendingClockStartRef.current = true');
    expect(source).toContain("event.reason === 'unexpected'");
    expect(source).toContain("event.reason === 'session-interruption'");
    expect(source).toContain("event.reason === 'runtime-error'");
    expect(source).toContain('unexpectedRecordingResumePendingRef.current');
    expect(source).toContain('shouldRetryRecoveredRecording');
    expect(source).toContain("armRecordingRecoveryWatchdog(event.reason)");
    expect(source).toContain("broadcastClientDiagnostic('recording-recovery-timeout'");
    expect(source).toContain("void pauseForRecordingFailure(reason)");
    expect(source).toContain("if (recordingRecoveryWatchdogRef.current) return");
    expect(source).toContain("void pauseForRecordingFailure('recording-start-failed')");
    expect(source).toContain("stopHoopsCameraRecordingAsync().catch(() => undefined)");
    expect(source).toContain("recordingStartedRef.current = false");
    expect(source).toContain("setCameraRecoveryBlocked(false)");
    expect(source).toContain("'Recording paused'");
    expect(source).toContain("pendingClockStartRef.current = true");
    expect(source).toContain("armRecordingRecoveryWatchdog('camera-start-confirmation')");
    expect(source).toContain("pendingClockStartRef.current &&");
    expect(source).toContain("setRunning(true)");
  });

  test('registers shared-video bridge methods on the primary WebRTC module', () => {
    expect(webRtcPatchSource).toContain('RCT_REMAP_METHOD(createHoopsCameraVideoStreamNative');
    expect(webRtcPatchSource).toContain('RCT_REMAP_METHOD(getHoopsCameraVideoStreamStatsNative');
    expect(webRtcPatchSource).toContain('kHoopsCameraPrimaryFrameCountKey');
    expect(webRtcPatchSource).toContain('RCT_REMAP_METHOD(releaseHoopsCameraVideoStreamNative');
    expect(webRtcPatchSource).toContain('kHoopsCameraPrimaryVideoTrackKey');
    expect(webRtcPatchSource).toContain('addObserverForName:@"HoopsCamera.videoSampleBuffer"');
    expect(webRtcPatchSource).toContain('@"peerConnectionId" : @(-1)');
    expect(nativeFacadeSource).not.toContain('createHoopsCameraVideoStreamNative?');
    expect(nativeFacadeSource).not.toContain('releaseHoopsCameraVideoStreamNative?');
    expect(nativeFacadeSource).toContain('await webRTCModule.createHoopsCameraVideoStreamNative()');
    expect(source).toContain("broadcastClientDiagnostic('live-video-failed'");
  });

  test('keeps MJPEG capture on the shared output and bounds native conversion', () => {
    expect(nativeCameraSource).toContain('startMjpeg');
    expect(nativeCameraSource).toContain('stopMjpeg');
    expect(nativeMjpegSource).toContain('minimumInterval');
    expect(nativeMjpegSource).toContain('1.0 / 3.0');
    expect(nativeMjpegSource).toContain('inFlight.wait(timeout: .now())');
    expect(nativeMjpegSource).toContain('CIContext');
    expect(nativeMjpegSource).toContain('640.0 / extent.width');
    expect(nativeMjpegSource).toContain('360.0 / extent.height');
    expect(nativeMjpegSource).toContain('base64EncodedString()');
    expect(nativeMjpegSource).toContain('maximumJPEGBytes');
    expect(nativeCameraSource).toContain('frameRouter.setMjpegFrameSink');
    expect(nativeCameraSource).toContain('frameRouter.clearMjpegSink()');
    expect(nativeMjpegSource).not.toContain('AVCaptureMovieFileOutput');
    const nativeMjpegStart = nativeCameraSource.slice(
      nativeCameraSource.indexOf('func startMjpeg(promise: Promise)'),
      nativeCameraSource.indexOf('func permissionStatus()'),
    );
    expect(nativeMjpegStart).toContain('frameRouter.startMjpeg()');
    expect(nativeMjpegStart).not.toContain('sessionQueue.async');
    expect(nativeMjpegStart).not.toContain('startSessionIfPossible()');
  });

  test('does not crop the iPad preview or background an active recording for Messages', () => {
    expect(source).toContain('style={StyleSheet.absoluteFill}');
    expect(source).not.toContain('scale > 1.01 ? { transform: [{ scale }] }');
    expect(source).toContain("if (recordingStartedRef.current || isRecording) {");
    expect(source).toContain('Share the live link before you start the game clock.');
    expect(source).toContain('cameraActive={!isSharingLiveLink || recordingStartedRef.current || isRecording}');
    expect(source).toContain('if (result.action === Share.sharedAction)');
    expect(source).toContain('activateLiveBroadcast(pending.code, dailyCredentialsRef.current ?? undefined)');
    expect(source).toContain('const anchor = findNodeHandle(sharePresentationAnchorRef.current)');
    expect(source).toContain('setShowGoLiveSheet(false)');
    expect(source).toContain("Platform.OS === 'ios' && anchor");
    expect(source).toContain('if (!didShare && !recoveryFailed) setShowGoLiveSheet(true)');
    expect(source).toContain('onDismiss={sharePendingLiveLink}');
    expect(source).toContain("if (Platform.OS !== 'ios')");
    expect(source).toContain('suspendHoopsCameraForSharingAsync(),');
    expect(source).toContain('resumeHoopsCameraAfterSharingAsync(),');
    expect(source).toContain("8_000");
    expect(source).toContain('cameraRecoveryBlocked');
    expect(source).toContain("if (cameraRecoveryBlocked)");
    expect(source).toContain("if (isSharingLiveLinkRef.current)");
    expect(source).toContain("!isSharingLiveLinkRef.current");
    expect(source).toContain('cameraReadyRef.current = false');
    expect(source).toContain('Camera did not recover');
    expect(nativeCameraSource).toContain('func suspendForSharing(promise: Promise)');
    expect(nativeCameraSource).toContain('func resumeAfterSharing(promise: Promise)');
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

  test('requires Live to start before recording so WebRTC cannot truncate the master film', () => {
    expect(source).toContain('if (recordingStartedRef.current || isRecording) {');
    expect(source).toContain('Recording protected — start Live before recording.');
    expect(source).not.toContain('Live video started — recording is still protected.');
    expect(source).toContain('Live video is active. Share the link after recording.');
    expect(source).toContain('setShowGoLiveSheet(false);');
    expect(source).toContain('<Ionicons name="lock-closed"');
    expect(source).toContain('LIVE · REC SAFE');
    expect(source).toContain("supportedOrientations={['portrait', 'landscape']}");
    expect(source).not.toContain('if ((recordingStartedRef.current || isRecording) && !sharedCameraMode) {');
  });

  test('enables the single-session shared native camera only in the isolated runtime', () => {
    expect(source).toContain('const ENABLE_SHARED_CAMERA_MODE = true');
    expect(source).toContain('ENABLE_SHARED_CAMERA_MODE &&');
    expect(source).toContain("Platform.OS === 'ios' &&\n    isHoopsCameraAvailable");
    expect(source).not.toContain("isHoopsCameraAvailable &&\n    isHoopsCameraWebRTCAvailable");
    expect(packageConfig.expo.autolinking.exclude).toBeUndefined();
    expect(packageConfig.dependencies).not.toHaveProperty('expo-screen-orientation');
    expect(appConfig.expo.runtimeVersion).toBe('1.0.0-daily-20260954');
    expect(appConfig.expo.ios.buildNumber).toBe('20260954');
  });

  test('keeps compact iPad stat controls readable and near the shooting controls', () => {
    expect(source).toContain("UNDO{'\\n'}MAKE");
    expect(source).toContain("UNDO{'\\n'}MISS");
    expect(source).toContain("justifyContent: isTabletLandscape ? 'space-evenly' : 'flex-start'");
    expect(source).toContain("flexWrap: isTabletLandscape ? 'wrap' : 'nowrap'");
    expect(source).toContain("flexBasis: isTabletLandscape ? '31%' : 0");
    expect(source).toContain("minHeight: isTabletLandscape ? 220");
    expect(source).toContain('minWidth: isTabletLandscape ? 100 : undefined');
    expect(source).toContain('scoreNum: { ...tekoStyle(isTabletLandscape ? 62 : 44)');
    expect(source).toContain('width: isTabletLandscape ? 52 : 34');
    expect(source).toContain('minWidth: isTabletLandscape ? 52 : undefined');
    expect(source).toContain('fontSize: isTabletLandscape ? 16 : 12');
    expect(source).not.toContain("justifyContent: isTablet ? 'space-evenly' : 'flex-start'");
  });

  test('shares an absolute encoded public watch URL', () => {
    expect(source).toContain('const publicOrigin = API_BASE');
    expect(source).toContain('/watch/${encodeURIComponent(code)}');
    expect(source).toContain('Watch ${teamName} live: ${url}');
  });

  test('shows a prominent Start Game action after sharing before gameplay begins', () => {
    expect(source).toContain('const [gameStarted, setGameStarted] = useState(false)');
    expect(source).toContain('setGameStarted(true)');
    expect(source).toContain('const hasGameActivity =');
    expect(source).toContain('gameStarted ||');
    expect(source).not.toContain('opponentScore !== 0 ||\\n    isRecording');
    expect(source).toContain('testID="start-game-footer"');
    expect(source).toContain('<Text style={styles.saveBtnText}>Start Game</Text>');
    expect(source).toContain(') : !hasGameActivity ? (');
  });
});