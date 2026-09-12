---
name: Mobile recording camera ownership
description: Why iOS recording and live WebRTC must share one native camera session
---

On iOS, local recording, preview, and live WebRTC video must use one shared native capture session. Recording has priority: the live branch is bounded and may drop late frames, but it must never block or backpressure the movie output. Older binaries and unsupported platforms retain score-only fallback while recording rather than opening a competing camera session.

**Why:** Physical iPad testing showed controls freezing after recording began and viewers failing to connect. Production logs confirmed that the live session and viewer page were created successfully, then the broadcaster disconnected. The shared cause was competing CameraView and WebRTC camera sessions. A later shared-session binary also terminated on Record Game entry, so architecture tests and native compilation alone are not enough.

**How to apply:** Never call a second video `getUserMedia` while the shared iOS recorder is active. Source WebRTC frames from the recording session, keep async live media and peer work session-fenced, and preserve score-only mode as the explicit failure/legacy fallback. Require physical cold-entry, repeated-entry, permission, background/foreground, and sustained recording tests before enabling a new shared-session binary; keep the score-only fallback available through OTA.