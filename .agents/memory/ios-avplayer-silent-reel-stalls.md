---
name: Silent AVPlayer reel stalls
description: Handling physical-device AVPlayer blackouts when a combined Highlight MP4 is structurally valid.
---

A combined Highlight MP4 can have continuous timestamps, decode fully with FFmpeg, and still turn black on physical-device AVPlayer at a former clip boundary without emitting `statusChange: error` or `playToEnd`.

**Why:** A production five-clip reel was verified end-to-end, including continuous packets across the reported boundary, but physical iOS playback silently froze after clip two and could not resume with the native Play control.

**How to apply:** Do not use the attempted no-B-frame/fixed-GOP encode or automatic playhead reattachment: physical-device testing regressed from two clips to less than one. Preserve the previous encode while investigating a different container/playback strategy.