import AVFoundation

/// The capture session can expose video samples to the WebRTC adapter without
/// giving that adapter ownership of the AVCaptureSession. The adapter is fed
/// asynchronously and has one in-flight sample: a slow WebRTC consumer drops
/// frames instead of ever back-pressuring AVCaptureVideoDataOutput or the
/// parallel AVCaptureMovieFileOutput recording.
final class HoopsCameraFrameRouter: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
  private let queue = DispatchQueue(label: "com.hoopsstats.camera.frames", qos: .userInitiated)
  private let lock = NSLock()
  private let inFlight = DispatchSemaphore(value: 1)
  private(set) var isRecording = false

  /// The WebRTC adapter installs this callback through the module boundary.
  /// It must not retain the sample after returning.
  var frameSink: ((CMSampleBuffer) -> Void)?

  func setRecording(_ recording: Bool) {
    lock.lock()
    isRecording = recording
    lock.unlock()
  }

  func captureOutput(
    _ output: AVCaptureOutput,
    didOutput sampleBuffer: CMSampleBuffer,
    from connection: AVCaptureConnection
  ) {
    lock.lock()
    let hasSink = frameSink != nil
    lock.unlock()
    guard hasSink, inFlight.wait(timeout: .now()) == .success else {
      return
    }

    // Recording has priority because this branch never waits. If WebRTC is
    // still processing the previous frame, the next live frame is discarded
    // while AVCaptureMovieFileOutput continues writing the master.
    queue.async { [weak self] in
      guard let self else {
        return
      }
      defer { self.inFlight.signal() }

      self.lock.lock()
      let frameSink = self.frameSink
      self.lock.unlock()

      guard let frameSink else {
        return
      }

      // This callback runs off AVCapture's sample callback queue. A slow
      // consumer holds only the single bounded slot above; subsequent frames
      // are discarded by captureOutput.
      frameSink(sampleBuffer)
    }
  }
}