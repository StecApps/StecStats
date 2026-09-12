import AVFoundation
import ExpoModulesCore
import UIKit

final class HoopsCameraPreviewView: ExpoView {
  private let controller = HoopsCameraSessionController.shared
  private let previewLayer: AVCaptureVideoPreviewLayer
  private var active = true
  private var facing = "back"
  private var normalizedZoom = 0.0

  let onPreviewReady = EventDispatcher()
  let onPreviewError = EventDispatcher()

  required init(appContext: AppContext? = nil) {
    previewLayer = AVCaptureVideoPreviewLayer(session: HoopsCameraSessionController.shared.session)
    super.init(appContext: appContext)
    backgroundColor = .black
    previewLayer.videoGravity = .resizeAspectFill
    layer.addSublayer(previewLayer)
    controller.attachPreview { [weak self] in
      DispatchQueue.main.async {
        self?.onPreviewReady(["state": "previewing"])
      }
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    previewLayer.frame = bounds
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil {
      controller.detachPreview()
    } else {
      controller.attachPreview()
    }
  }

  deinit {
    controller.detachPreview()
  }

  func updateActive(_ value: Bool) {
    active = value
    controller.setPreviewActive(value)
  }

  func updateFacing(_ value: String) {
    facing = value
    controller.setFacing(
      value,
      onSuccess: { [weak self] in
        self?.onPreviewReady(["state": "previewing"])
      },
      onError: { [weak self] exception in
        self?.onPreviewError([
          "code": exception.code,
          "message": exception.description,
          "recoverable": true
        ])
      }
    )
  }

  func updateZoom(_ value: Double) {
    normalizedZoom = value
    controller.setZoom(value)
  }
}