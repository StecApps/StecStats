---
name: Recording-safe MJPEG fallback
description: Constraints for using MJPEG as a last-resort live video path while native game recording continues.
---

MJPEG conversion must reuse the recorder's existing video data output, remain frame-rate limited with one conversion in flight, and have backpressure independent of the WebRTC consumer. Starting or stopping MJPEG must only toggle the synchronized frame producer; it must never enqueue capture-session startup, shutdown, or repeated retries on the recorder's serial AVFoundation queue. Advertise MJPEG only after the first encoded frame reaches JavaScript.

**Why:** The fallback exists specifically for sessions where the shared WebRTC track reports no encoded frames. Sharing the WebRTC semaphore can starve it, while timed-out native retries can remain queued and delay the real movie recording even though JavaScript has already moved on.

**How to apply:** Keep Live media passive and subordinate to recording. Use one bounded start, retry only after an authoritative camera-ready state, require a real first frame, and stop all Live media before finalizing the movie while retaining the socket long enough to acknowledge finalization diagnostics.