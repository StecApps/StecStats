---
name: Daily recording quality gate
description: Avoid paying for upscaled cloud recordings when the camera source is lower resolution.
---

Request a higher-quality Daily cloud recording only when the local camera track reports real high-resolution frames. If the camera cannot report dimensions, retain the proven lower-resolution recording profile rather than treating a larger output canvas as an improvement.

**Why:** A production game's Daily master was already visibly soft at 720p; its playback derivative further reduced bitrate. Raising only Daily's cloud-output dimensions could produce a larger, costlier upscale with no added detail. Daily bills recording by minute, but larger media still increases storage, upload/download traffic, and processing.

**How to apply:** When adjusting Live recording quality, consider the camera input, WebRTC sender, cloud recording composition, and final downloaded master separately. Validate the resulting file from a physical iPad before claiming true higher-resolution footage or broadening settings.