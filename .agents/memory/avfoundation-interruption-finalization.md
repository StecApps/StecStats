---
name: AVFoundation interruption finalization
description: Why an interrupted native movie recording must be explicitly finalized before recovery.
---

When `AVCaptureSession.wasInterruptedNotification` or a runtime error arrives during an `AVCaptureMovieFileOutput` recording, explicitly call `stopRecording()` and wait for `didFinishRecordingTo` before restarting the capture session or starting a recovery segment. Never call synchronous `startRunning()` ahead of the movie delegate on the same serial queue.

**Why:** Physical iPad tests produced 10–15 second movies while JavaScript kept advancing to 26+ seconds. Interruption recovery could queue `startRunning()` before `didFinishRecordingTo`, blocking the finalization callback and all bridge diagnostics behind it.

**How to apply:** Treat native `didStartRecordingTo` and `didFinishRecordingTo` as authoritative boundaries. Defer one guarded restart until finalization completes; explicit stop must synchronously suppress auto-recovery before it waits on the session queue.