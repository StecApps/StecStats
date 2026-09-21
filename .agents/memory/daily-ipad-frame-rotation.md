---
name: Daily iPad frame rotation
description: The WebRTC camera rotation fallback that can send landscape-only iPad video sideways.
---

For landscape-only iPad Live capture, correct RTC frame rotation at the outgoing native frame boundary instead of changing only the preview layout.

**Why:** WebRTC defaults unknown, face-up, or face-down iOS device orientation to portrait rotation. An iPad mounted flat on a tripod can therefore send a sideways stream even though the app interface is locked to landscape.

**How to apply:** Preserve normal phone behavior, but on iPad map landscape-left/right to 0°/180° (including the front-camera inversion) before frames reach the RTC video source.