---
name: Silent AVPlayer reel stalls
description: Handling physical-device AVPlayer blackouts when a combined Highlight MP4 is structurally valid.
---

A combined Highlight MP4 can have continuous timestamps, decode fully with FFmpeg, and still turn black on physical-device AVPlayer at a former clip boundary without emitting `statusChange: error` or `playToEnd`.

**Why:** A production five-clip reel was verified end-to-end, including continuous packets across the reported boundary, but physical iOS playback silently froze after clip two and could not resume with the native Play control.

**How to apply:** Encode combined reels as CFR H.264 with no B-frames, a bounded keyframe cadence, and an explicit video track timescale. For verified local reels, monitor an actively playing but non-advancing playhead and reattach the same file once at the last confirmed timestamp.