---
name: Daily recording quality gate
description: Avoid paying for upscaled cloud recordings when the camera source is lower resolution.
---

Request a higher-quality Daily cloud recording only when the local camera track reports real high-resolution frames. If the camera cannot report dimensions, retain the proven lower-resolution recording profile rather than treating a larger output canvas as an improvement.

**Why:** A production game's Daily master was already visibly soft at 720p; its playback derivative further reduced bitrate. Raising only Daily's cloud-output dimensions could produce a larger, costlier upscale with no added detail. Daily bills recording by minute, but larger media still increases storage, upload/download traffic, and processing.

**How to apply:** When adjusting Live recording quality, consider the camera input, WebRTC sender, cloud recording composition, and final downloaded master separately. Validate the resulting file from a physical iPad before claiming true higher-resolution footage or broadening settings.

Daily's documented React Native default sender profile targets a 1280×720 top layer at only about 520 kb/s, and the native WebRTC camera defaults to the front lens if no facing constraint is supplied. A cloud MP4 encoded at ~3 Mb/s therefore does not prove that the camera uploaded a sharp 3 Mb/s feed. In a production comparison, a newer test game's original was still 720p at ~3 Mb/s after requesting ideal 1080p, so the first quality request did not establish a better source.

**Why:** Output dimensions and bitrate can conceal a downscaled or compressed input, and a constructor-level preference may not establish what the native camera actually applied.

**How to apply:** Keep the UI-selected lens explicit; inspect the local track's measured settings after Daily joins and applies input settings, then inspect the imported original. Do not promise that changing the cloud recording profile alone improves court details.