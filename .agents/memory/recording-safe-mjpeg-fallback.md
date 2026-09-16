---
name: Recording-safe MJPEG fallback
description: Constraints for using MJPEG as a last-resort live video path while native game recording continues.
---

MJPEG conversion must reuse the recorder's existing video data output, remain frame-rate limited with one conversion in flight, and have backpressure independent of the WebRTC consumer. A hung WebRTC sink must not prevent MJPEG from receiving frames.

**Why:** The fallback exists specifically for sessions where the shared WebRTC track reports no encoded frames. Sharing the WebRTC semaphore or early-return path can starve the fallback under the exact failure it is meant to recover.

**How to apply:** Activate MJPEG only after a confirmed outbound failure or connection timeout. Treat the mode switch as a complete viewer-state transition: remove any score-only overlay, announce MJPEG explicitly, and use ownership tokens so stale async starts cannot stop a newer fallback.