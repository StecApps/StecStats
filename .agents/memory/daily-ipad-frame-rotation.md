---
name: Daily iPad frame rotation
description: The WebRTC camera rotation fallback that can send landscape-only iPad video sideways.
---

For landscape-only iPad Live capture, correct RTC frame rotation at the outgoing native frame boundary instead of changing only the preview layout.

**Why:** WebRTC defaults unknown, face-up, or face-down iOS device orientation to portrait rotation. An iPad mounted flat on a tripod can therefore send a sideways stream even though the app interface is locked to landscape.

**How to apply:** Preserve normal phone behavior. On iPad, derive the correction from each RTC frame's rotation metadata: convert 90° to 180° and 270° to 0°, while preserving existing 0°/180° values. Do not infer the correction from UIDevice orientation or camera position; WebRTC changes the frame metadata when switching lenses.