---
name: Daily iPad frame rotation
description: The WebRTC camera rotation fallback that can send landscape-only iPad video sideways.
---

For landscape-only iPad Live capture, correct RTC frame rotation at the outgoing native frame boundary instead of changing only the preview layout.

**Why:** WebRTC defaults unknown, face-up, or face-down iOS device orientation to portrait rotation. An iPad mounted flat on a tripod can therefore send a sideways stream even though the app interface is locked to landscape.

**How to apply:** Preserve normal phone behavior. On iPad, derive the correction from each RTC frame's rotation metadata: convert 90° to 180° and 270° to 0°, while preserving existing 0°/180° values. Do not infer the correction from UIDevice orientation or camera position; WebRTC changes the frame metadata when switching lenses.

Game-day capture is intended to use the rear camera only; the user did not request or want a selfie mode. Do not preserve front-camera behavior as a product constraint when fixing rear-camera startup and orientation.

The user reported that an iPad Daily Live recording turned upside down partway through filming despite this correction. Actual short Daily cloud recordings were subsequently inspected: the outward-facing court footage was upside down from its first playable frames, even though the selfie preview had appeared upright. The stored MP4 does not reveal the original RTC frame-rotation values, so do not guess a universal 180° correction or assume the current mapping is proven. A fix at this native capture boundary needs a new installed iOS build and a physical-device Live/recording check; a JavaScript-only app update or website republish cannot repair the captured frames.