import AVFoundation
import ExpoModulesCore

public final class HoopsCameraModule: Module {
  private let controller = HoopsCameraSessionController.shared

  public func definition() -> ModuleDefinition {
    Name("HoopsCamera")

    Events("onStateChange", "onError", "onRecordingFinished", "onLifecycleResume", "onMjpegFrame")

    Constants {
      [
        "frameQueueCapacity": 1,
        "recordingHasPriority": true,
        "supportsWebRTCFrameSink": true
      ]
    }

    OnCreate {
      controller.activateFrameRouting()
      controller.eventHandler = { [weak self] eventName, payload in
        self?.sendEvent(eventName, payload)
      }
    }

    OnDestroy {
      controller.invalidate()
    }

    OnAppEntersBackground {
      controller.stopForLifecycle()
    }

    OnAppEntersForeground {
      controller.resumeFromLifecycle()
    }

    AsyncFunction("getPermissionStatusAsync") {
      controller.permissionStatus()
    }

    AsyncFunction("requestPermissionsAsync") { (promise: Promise) in
      controller.requestPermissions(promise: promise)
    }

    AsyncFunction("startRecordingAsync") { (muted: Bool, promise: Promise) in
      controller.startRecording(muted: muted, promise: promise)
    }

    AsyncFunction("stopRecordingAsync") { (promise: Promise) in
      controller.stopRecording(promise: promise)
    }

    AsyncFunction("startMjpegAsync") { (promise: Promise) in
      controller.startMjpeg(promise: promise)
    }

    AsyncFunction("stopMjpegAsync") { (promise: Promise) in
      controller.stopMjpeg(promise: promise)
    }

    AsyncFunction("suspendForSharingAsync") { (promise: Promise) in
      controller.suspendForSharing(promise: promise)
    }

    AsyncFunction("resumeAfterSharingAsync") { (promise: Promise) in
      controller.resumeAfterSharing(promise: promise)
    }

    AsyncFunction("setMicrophoneMutedAsync") { (muted: Bool, promise: Promise) in
      controller.setMicrophoneMuted(muted, promise: promise)
    }

    AsyncFunction("setFacingAsync") { (facing: String, promise: Promise) in
      guard facing == "front" || facing == "back" else {
        promise.reject("ERR_HOOPS_CAMERA_FACING", "Facing must be front or back.")
        return
      }
      controller.setFacing(facing, promise: promise)
    }

    AsyncFunction("setZoomAsync") { (zoom: Double, promise: Promise) in
      guard zoom.isFinite, zoom >= 0, zoom <= 1 else {
        promise.reject("ERR_HOOPS_CAMERA_ZOOM", "Zoom must be between 0 and 1.")
        return
      }
      controller.setZoom(zoom, promise: promise)
    }

    View(HoopsCameraPreviewView.self) {
      Events("onPreviewReady", "onPreviewError")

      Prop("active", true) { (view, active: Bool) in
        view.updateActive(active)
      }

      Prop("facing", "back") { (view, facing: String) in
        view.updateFacing(facing)
      }

      Prop("zoom", 0.0) { (view, zoom: Double) in
        view.updateZoom(zoom)
      }
    }
  }
}