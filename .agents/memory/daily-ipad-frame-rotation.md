---
name: Daily iPad frame rotation
description: The WebRTC camera rotation fallback that can send landscape-only iPad video sideways.
---

For landscape-only iPad Live capture, correct RTC frame rotation at the outgoing native frame boundary instead of changing only the preview layout.

**Why:** WebRTC defaults unknown, face-up, or face-down iOS device orientation to portrait rotation. An iPad mounted flat on a tripod can therefore send a sideways stream even though the app interface is locked to landscape.

**How to apply:** Preserve normal phone behavior. On iPad, derive the correction from each RTC frame's rotation metadata: convert 90° to 180° and 270° to 0°, while preserving existing 0°/180° values. Do not infer the correction from UIDevice orientation or camera position; WebRTC changes the frame metadata when switching lenses.

The user reported that an iPad Daily Live recording turned upside down partway through filming despite this correction. Treat the mapping as an incomplete mitigation, not proof that orientation stays stable for an entire recording. A fix at this native capture boundary needs a new installed iOS build and a physical-device Live/recording check; a JavaScript-only app update or website republish cannot repair the captured frames.