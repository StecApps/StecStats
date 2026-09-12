import AVFoundation
import ExpoModulesCore
import UIKit

/// Private native-module boundary shared with the react-native-webrtc patch.
/// HoopsCamera deliberately does not import or link WebRTC; the WebRTC module
/// observes this notification and owns conversion into RTCVideoFrame.
let hoopsCameraVideoSampleBufferNotification = Notification.Name("HoopsCamera.videoSampleBuffer")

enum HoopsCameraSessionError: Error {
  case cameraPermissionDenied
  case microphonePermissionDenied
  case sessionUnavailable
  case alreadyRecording
  case notRecording
  case cannotChangeFacingWhileRecording
  case recordingFailed(String)
}

extension HoopsCameraSessionError: CustomNSError {
  var errorCode: Int {
    switch self {
    case .cameraPermissionDenied: return 1001
    case .microphonePermissionDenied: return 1002
    case .sessionUnavailable: return 1003
    case .alreadyRecording: return 1004
    case .notRecording: return 1005
    case .cannotChangeFacingWhileRecording: return 1006
    case .recordingFailed: return 1007
    }
  }

  var errorDomain: String {
    "HoopsCamera"
  }

  var errorUserInfo: [String: Any] {
    [NSLocalizedDescriptionKey: localizedDescription]
  }

  var localizedDescription: String {
    switch self {
    case .cameraPermissionDenied:
      return "Camera permission has not been granted."
    case .microphonePermissionDenied:
      return "Microphone permission has not been granted."
    case .sessionUnavailable:
      return "The camera session could not be configured."
    case .alreadyRecording:
      return "A recording is already in progress."
    case .notRecording:
      return "There is no recording in progress."
    case .cannotChangeFacingWhileRecording:
      return "Camera facing cannot change while recording; recording has priority."
    case let .recordingFailed(message):
      return "The camera recording failed: \(message)"
    }
  }
}

/// Owns the only AVCaptureSession used by HoopsCamera. All AVFoundation
/// mutations run on sessionQueue; UI preview layers only observe this session.
final class HoopsCameraSessionController: NSObject, AVCaptureFileOutputRecordingDelegate {
  static let shared = HoopsCameraSessionController()

  let session = AVCaptureSession()
  private let sessionQueue = DispatchQueue(label: "com.hoopsstats.camera.session", qos: .userInitiated)
  private let frameRouter = HoopsCameraFrameRouter()
  private let movieOutput = AVCaptureMovieFileOutput()
  private var videoInput: AVCaptureDeviceInput?
  private var audioInput: AVCaptureDeviceInput?
  private var videoDataOutput: AVCaptureVideoDataOutput?
  private var isConfigured = false
  private var isPreviewAttached = false
  private var isPreviewActive = true
  private var isRecording = false
  private var recordingPromise: Promise?
  private var facing: AVCaptureDevice.Position = .back
  private var normalizedZoom: CGFloat = 0

  var eventHandler: ((String, [String: Any]) -> Void)?
  var previewReadyHandler: (() -> Void)?

  private override init() {
    super.init()
    frameRouter.frameSink = { sampleBuffer in
      NotificationCenter.default.post(
        name: hoopsCameraVideoSampleBufferNotification,
        object: sampleBuffer
      )
    }
  }

  func permissionStatus() -> [String: String] {
    func status(_ value: AVAuthorizationStatus) -> String {
      switch value {
      case .authorized: return "granted"
      case .denied, .restricted: return "denied"
      case .notDetermined: return "undetermined"
      @unknown default: return "denied"
      }
    }
    return [
      "camera": status(AVCaptureDevice.authorizationStatus(for: .video)),
      "microphone": status(AVCaptureDevice.authorizationStatus(for: .audio))
    ]
  }

  func requestPermissions(promise: Promise) {
    AVCaptureDevice.requestAccess(for: .video) { [weak self] cameraGranted in
      guard let self else {
        promise.reject("ERR_HOOPS_CAMERA_UNAVAILABLE", "The camera module was released.")
        return
      }
      guard cameraGranted else {
        promise.resolve(self.permissionStatus())
        self.emitError(HoopsCameraSessionError.cameraPermissionDenied, recoverable: false)
        return
      }
      AVCaptureDevice.requestAccess(for: .audio) { [weak self] _ in
        guard let self else {
          promise.reject("ERR_HOOPS_CAMERA_UNAVAILABLE", "The camera module was released.")
          return
        }
        self.sessionQueue.async {
          self.configureIfNeeded()
          if self.isPreviewAttached && self.isPreviewActive {
            self.startSessionIfPossible()
          }
          promise.resolve(self.permissionStatus())
        }
      }
    }
  }

  func attachPreview(onReady: (() -> Void)? = nil) {
    sessionQueue.async {
      self.isPreviewAttached = true
      if let onReady {
        self.previewReadyHandler = onReady
      }
      self.configureIfNeeded()
      if self.isPreviewActive {
        self.startSessionIfPossible()
      }
    }
  }

  func detachPreview() {
    sessionQueue.async {
      self.isPreviewAttached = false
      if !self.isRecording {
        self.stopSession()
      }
    }
  }

  func setPreviewActive(_ active: Bool) {
    sessionQueue.async {
      self.isPreviewActive = active
      if active {
        self.configureIfNeeded()
        self.startSessionIfPossible()
      } else if !self.isRecording {
        self.stopSession()
      }
    }
  }

  func setFacing(
    _ value: String,
    promise: Promise? = nil,
    onSuccess: (() -> Void)? = nil,
    onError: ((Exception) -> Void)? = nil
  ) {
    sessionQueue.async {
      guard !self.isRecording else {
        self.reject(
          HoopsCameraSessionError.cannotChangeFacingWhileRecording,
          promise: promise,
          onError: onError
        )
        return
      }
      let position: AVCaptureDevice.Position = value == "front" ? .front : .back
      guard position != self.facing else {
        promise?.resolve(nil)
        onSuccess?()
        return
      }
      guard let device = self.cameraDevice(position: position),
            let input = try? AVCaptureDeviceInput(device: device) else {
        self.reject(
          "ERR_HOOPS_CAMERA_UNAVAILABLE",
          "The requested camera is unavailable.",
          promise: promise,
          onError: onError
        )
        return
      }
      self.session.beginConfiguration()
      if let oldInput = self.videoInput {
        self.session.removeInput(oldInput)
      }
      guard self.session.canAddInput(input) else {
        if let oldInput = self.videoInput {
          self.session.addInput(oldInput)
        }
        self.session.commitConfiguration()
        self.reject(
          "ERR_HOOPS_CAMERA_UNAVAILABLE",
          "The requested camera could not be added.",
          promise: promise,
          onError: onError
        )
        return
      }
      self.session.addInput(input)
      self.session.commitConfiguration()
      self.videoInput = input
      self.facing = position
      self.applyZoom()
      promise?.resolve(nil)
      onSuccess?()
    }
  }

  func setZoom(
    _ value: Double,
    promise: Promise? = nil,
    onSuccess: (() -> Void)? = nil,
    onError: ((Exception) -> Void)? = nil
  ) {
    sessionQueue.async {
      self.normalizedZoom = CGFloat(min(max(value, 0), 1))
      self.applyZoom()
      promise?.resolve(nil)
      onSuccess?()
    }
  }

  func startRecording(promise: Promise) {
    sessionQueue.async {
      guard !self.isRecording else {
        promise.reject(HoopsCameraSessionError.alreadyRecording)
        return
      }
      guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else {
        promise.reject(HoopsCameraSessionError.cameraPermissionDenied)
        self.emitError(HoopsCameraSessionError.cameraPermissionDenied, recoverable: false)
        return
      }
      guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
        promise.reject(HoopsCameraSessionError.microphonePermissionDenied)
        self.emitError(HoopsCameraSessionError.microphonePermissionDenied, recoverable: false)
        return
      }

      self.configureIfNeeded()
      guard self.isConfigured,
            self.session.canAddOutput(self.movieOutput) || self.session.outputs.contains(where: { $0 === self.movieOutput }) else {
        promise.reject(HoopsCameraSessionError.sessionUnavailable)
        return
      }
      if !self.session.isRunning {
        self.startSessionIfPossible()
      }
      let cacheDirectory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      let url = cacheDirectory
        .appendingPathComponent("hoops-recording-\(UUID().uuidString)")
        .appendingPathExtension("mov")
      self.recordingPromise = promise
      self.isRecording = true
      self.frameRouter.setRecording(true)
      self.movieOutput.startRecording(to: url, recordingDelegate: self)
      self.emitState("recording", reason: nil)
    }
  }

  func stopRecording(promise: Promise) {
    sessionQueue.async {
      guard self.isRecording else {
        promise.reject(HoopsCameraSessionError.notRecording)
        return
      }
      // The recording delegate resolves the original start promise and this
      // stop promise together after AVFoundation has finalized the file.
      self.recordingPromise = self.recordingPromise ?? promise
      self.stopPromise = promise
      self.movieOutput.stopRecording()
    }
  }

  func stopForLifecycle() {
    sessionQueue.async {
      guard self.isRecording || self.session.isRunning else {
        return
      }
      if self.isRecording {
        self.movieOutput.stopRecording()
      } else {
        self.stopSession()
        self.emitState("paused", reason: "app-backgrounded")
      }
    }
  }

  func resumeFromLifecycle() {
    sessionQueue.async {
      guard self.isPreviewAttached, self.isPreviewActive else {
        return
      }
      self.configureIfNeeded()
      self.startSessionIfPossible()
    }
  }

  func invalidate() {
    sessionQueue.async {
      if self.isRecording {
        self.movieOutput.stopRecording()
      }
      self.stopSession()
      self.recordingPromise = nil
      self.stopPromise = nil
    }
  }

  private var stopPromise: Promise?

  private func configureIfNeeded() {
    guard !isConfigured else {
      return
    }
    guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else {
      emitError(HoopsCameraSessionError.cameraPermissionDenied, recoverable: false)
      return
    }
    guard let device = cameraDevice(position: facing),
          let input = try? AVCaptureDeviceInput(device: device),
          session.canAddInput(input) else {
      emitError(HoopsCameraSessionError.sessionUnavailable, recoverable: false)
      return
    }

    session.beginConfiguration()
    session.sessionPreset = .high
    session.addInput(input)
    videoInput = input

    if AVCaptureDevice.authorizationStatus(for: .audio) == .authorized,
       let audioDevice = AVCaptureDevice.default(for: .audio),
       let input = try? AVCaptureDeviceInput(device: audioDevice),
       session.canAddInput(input) {
      session.addInput(input)
      audioInput = input
    }

    if session.canAddOutput(movieOutput) {
      session.addOutput(movieOutput)
    }

    let dataOutput = AVCaptureVideoDataOutput()
    dataOutput.alwaysDiscardsLateVideoFrames = true
    dataOutput.videoSettings = [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
    ]
    if session.canAddOutput(dataOutput) {
      session.addOutput(dataOutput)
      dataOutput.setSampleBufferDelegate(frameRouter, queue: DispatchQueue(label: "com.hoopsstats.camera.samples", qos: .userInitiated))
      videoDataOutput = dataOutput
    }
    session.commitConfiguration()
    isConfigured = true
    applyZoom()
  }

  private func cameraDevice(position: AVCaptureDevice.Position) -> AVCaptureDevice? {
    AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position)
      ?? AVCaptureDevice.default(for: .video)
  }

  private func applyZoom() {
    guard let device = videoInput?.device else {
      return
    }
    do {
      try device.lockForConfiguration()
      let maxZoom = min(device.activeFormat.videoMaxZoomFactor, 8)
      device.videoZoomFactor = 1 + (maxZoom - 1) * normalizedZoom
      device.unlockForConfiguration()
    } catch {
      emitError(.recordingFailed("Unable to apply camera zoom: \(error.localizedDescription)"), recoverable: true)
    }
  }

  private func startSessionIfPossible() {
    guard isConfigured, !session.isRunning else {
      return
    }
    session.startRunning()
    guard session.isRunning else {
      emitError(HoopsCameraSessionError.sessionUnavailable, recoverable: true)
      return
    }
    emitState("previewing", reason: nil)
    previewReadyHandler?()
  }

  private func stopSession() {
    guard session.isRunning else {
      return
    }
    session.stopRunning()
    emitState("stopped", reason: "preview-detached")
  }

  func fileOutput(
    _ output: AVCaptureFileOutput,
    didFinishRecordingTo outputFileURL: URL,
    from connections: [AVCaptureConnection],
    error: Error?
  ) {
    sessionQueue.async {
      self.isRecording = false
      self.frameRouter.setRecording(false)
      let result = ["uri": outputFileURL.absoluteString]
      let startPromise = self.recordingPromise
      let stopPromise = self.stopPromise
      self.recordingPromise = nil
      self.stopPromise = nil

      if let error {
        let cameraError = HoopsCameraSessionError.recordingFailed(error.localizedDescription)
        startPromise?.reject(cameraError)
        stopPromise?.reject(cameraError)
        self.emitError(cameraError, recoverable: true)
      } else {
        startPromise?.resolve(result)
        stopPromise?.resolve(result)
        self.emitEvent("onRecordingFinished", [
          "uri": outputFileURL.absoluteString,
          "reason": "stopped"
        ])
      }
      self.emitState(self.isPreviewActive ? "previewing" : "stopped", reason: "recording-finished")
      if !self.isPreviewAttached && !self.isRecording {
        self.stopSession()
      }
    }
  }

  private func emitState(_ state: String, reason: String?) {
    var payload: [String: Any] = [
      "state": state,
      "isRecording": isRecording
    ]
    if let reason {
      payload["reason"] = reason
    }
    emitEvent("onStateChange", payload)
  }

  private func emitError(_ error: HoopsCameraSessionError, recoverable: Bool) {
    emitEvent("onError", [
      "code": "ERR_HOOPS_CAMERA_\(error.errorCode)",
      "message": error.localizedDescription,
      "recoverable": recoverable
    ])
  }

  private func emitEvent(_ name: String, _ payload: [String: Any]) {
    eventHandler?(name, payload)
  }

  private func reject(
    _ error: Error,
    promise: Promise?,
    onError: ((Exception) -> Void)?
  ) {
    if let promise {
      promise.reject(error)
    } else if let exception = error as? Exception {
      onError?(exception)
    } else {
      onError?(Exception(name: "ERR_HOOPS_CAMERA", description: error.localizedDescription, code: "ERR_HOOPS_CAMERA"))
    }
  }

  private func reject(
    _ code: String,
    _ description: String,
    promise: Promise?,
    onError: ((Exception) -> Void)?
  ) {
    if let promise {
      promise.reject(code, description)
    } else {
      onError?(Exception(name: code, description: description, code: code))
    }
  }
}