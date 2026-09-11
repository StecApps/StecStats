---
name: Mobile recording camera ownership
description: Why local recording and live WebRTC video must not open independent camera sessions on iPad
---

When a mobile game is configured for local video recording, the recording camera must be the only native owner of the camera. Live viewers should receive the real-time scoreboard in score-only mode rather than opening a second WebRTC capture session.

**Why:** Physical iPad testing showed controls freezing after recording began and viewers failing to connect. Production logs confirmed that the live session and viewer page were created successfully, then the broadcaster disconnected. The shared cause was competing CameraView and WebRTC camera sessions.

**How to apply:** Treat local recording as higher priority than live video on both iOS and Android. Advertise score-only mode in the broadcaster's first signaling message so viewers never wait for an offer that cannot arrive. Supporting both requires one shared capture pipeline, not two native camera clients.