---
name: Mobile recording camera ownership
description: Why iOS recording and live WebRTC must share one native camera session
---

On iOS, local recording, preview, and live WebRTC video must use one shared native capture session. Recording has priority: the live branch is bounded and may drop late frames, but it must never block or backpressure the movie output. Older binaries and unsupported platforms retain score-only fallback while recording rather than opening a competing camera session.

**Why:** Physical iPad testing showed controls freezing after recording began and viewers failing to connect. Production logs confirmed that the live session and viewer page were created successfully, then the broadcaster disconnected. The shared cause was competing CameraView and WebRTC camera sessions. A later shared-session binary also terminated on Record Game entry; its asynchronous frame router used AVCapture sample buffers after the delegate callback without taking ownership, creating a native lifetime race.

**How to apply:** Never call a second video `getUserMedia` while the shared iOS recorder is active. Source WebRTC frames from the recording session, copy or retain each sample before asynchronous handoff, synchronize sink teardown, and keep async media work session-fenced. Preserve score-only as the explicit failure/legacy fallback. Require physical cold-entry, repeated-entry, simultaneous Live + recording, background/foreground, and sustained recording tests for every shared-session binary.