import AVFoundation
import CoreImage
import CoreMedia
import ImageIO
import UIKit

/// Best-effort JPEG encoder for the camera's existing video data output.
/// It never waits on the capture callback: one conversion is allowed at a time.
final class HoopsCameraMjpegFrameProducer {
  private let queue = DispatchQueue(label: "com.hoopsstats.camera.mjpeg", qos: .utility)
  private let lock = NSLock()
  private let inFlight = DispatchSemaphore(value: 1)
  private let context = CIContext(options: [.cacheIntermediates: false])
  private var enabled = false
  private var lastSubmittedAt: TimeInterval = 0
  private var frameSink: ((String) -> Void)?

  private let minimumInterval: TimeInterval = 1.0 / 3.0
  private let maximumJPEGBytes = 512 * 1024

  func setFrameSink(_ sink: ((String) -> Void)?) {
    lock.lock()
    frameSink = sink
    lock.unlock()
  }

  func start() {
    lock.lock()
    enabled = true
    lastSubmittedAt = 0
    lock.unlock()
  }

  func stop() {
    lock.lock()
    enabled = false
    lock.unlock()
  }

  var isEnabled: Bool {
    lock.lock()
    defer { lock.unlock() }
    return enabled && frameSink != nil
  }

  /// Called from HoopsCameraFrameRouter's sample callback. All expensive work
  /// is deferred to the producer queue and late frames are discarded first.
  func submit(
    _ sampleBuffer: CMSampleBuffer,
    orientation: AVCaptureVideoOrientation?,
    mirrored: Bool
  ) {
    let now = ProcessInfo.processInfo.systemUptime
    lock.lock()
    guard enabled, frameSink != nil, now - lastSubmittedAt >= minimumInterval else {
      lock.unlock()
      return
    }
    guard inFlight.wait(timeout: .now()) == .success else {
      lock.unlock()
      return
    }
    lastSubmittedAt = now
    lock.unlock()

    queue.async { [weak self] in
      guard let self else { return }
      defer { self.inFlight.signal() }

      self.lock.lock()
      let enabled = self.enabled
      let sink = self.frameSink
      self.lock.unlock()
      guard enabled, let sink, let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
        return
      }

      var image = CIImage(cvPixelBuffer: pixelBuffer)
      if let orientation {
        let exifOrientation: Int32
        switch orientation {
        case .portrait: exifOrientation = mirrored ? 2 : 6
        case .portraitUpsideDown: exifOrientation = mirrored ? 1 : 8
        case .landscapeRight: exifOrientation = mirrored ? 4 : 3
        case .landscapeLeft: exifOrientation = mirrored ? 5 : 7
        @unknown default: exifOrientation = 1
        }
        image = image.oriented(forExifOrientation: exifOrientation)
      }

      let extent = image.extent.integral
      guard extent.width > 0, extent.height > 0 else { return }
      let scale = min(640.0 / extent.width, 360.0 / extent.height, 1.0)
      let resized = image
        .transformed(by: CGAffineTransform(
          a: scale,
          b: 0,
          c: 0,
          d: scale,
          tx: -extent.minX * scale,
          ty: -extent.minY * scale
        ))
        .cropped(to: CGRect(
          x: 0,
          y: 0,
          width: ceil(extent.width * scale),
          height: ceil(extent.height * scale)
        ))
      guard let data = self.context.jpegRepresentation(
        of: resized,
        colorSpace: CGColorSpaceCreateDeviceRGB(),
        options: [CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): 0.5]
      ), data.count <= self.maximumJPEGBytes else {
        return
      }

      self.lock.lock()
      let stillEnabled = self.enabled
      let currentSink = self.frameSink
      self.lock.unlock()
      guard stillEnabled, let currentSink else { return }
      currentSink(data.base64EncodedString())
    }
  }
}