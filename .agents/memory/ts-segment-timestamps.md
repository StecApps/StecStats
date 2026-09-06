---
name: TS segment absolute timestamps
description: iOS needs reset TS inputs plus a freshly encoded continuous final timeline; stream-copy concat can remain seekable but stall at clip boundaries.
---

## Rule
When encoding MPEG-TS clip segments with ffmpeg's fast-seek (`-ss` before `-i`), add `-reset_timestamps 1`. When assembling multiple independently rendered segments, do not stream-copy them into the final MP4: rebuild one zero-based CFR H.264/AAC timeline with `setpts`/`asetpts`.

**Why:** iOS is strict about both initial PTS and boundary continuity. A stream-copy concat can look complete, report the full duration, and seek to the end while normal AVPlayer playback stalls or turns black at the first 10–15 second clip boundary.

**How to apply:** Reset every MPEG-TS segment:
```
args.push("-reset_timestamps", "1");
args.push("-f", "mpegts", segPath);
```
For the final MP4, normalize video with `setpts=N/(fps*TB)`, audio with `asetpts=N/SR/TB`, re-encode to H.264 Main/yuv420p plus AAC, generate CFR timestamps, avoid negative timestamps, and use `+faststart`. Test deliberately offset input PTS, frame count/duration, and decode through EOF.
