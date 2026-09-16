---
name: AVFoundation interruption finalization
description: Why an interrupted native movie recording must be explicitly finalized before recovery.
---

When `AVCaptureSession.wasInterruptedNotification` or a runtime error arrives during an `AVCaptureMovieFileOutput` recording, explicitly call `stopRecording()` and wait for `didFinishRecordingTo` before starting a recovery segment. Setting an internal stop reason alone is insufficient.

**Why:** A physical iPad test ran for roughly three minutes while native and JavaScript state still reported recording, but the resulting movie contained only the first ten-second playable prefix. The interruption notification had not told the movie output to finalize, so terminal save logic suppressed recovery.

**How to apply:** Treat native `didStartRecordingTo` and `didFinishRecordingTo` as the authoritative boundaries. On interruption, finalize immediately, retain the usable segment, then resume into a new segment only if recording is still desired and no terminal save intent exists.