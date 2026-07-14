---
name: TS segment absolute timestamps
description: ffmpeg fast-seek (-ss before -i) inherits source stream PTS; TS output keeps the absolute timestamp, breaking iOS Safari playback when concatenated into MP4.
---

## Rule
When encoding MPEG-TS clip segments with ffmpeg's fast-seek (`-ss` before `-i`), always add `-reset_timestamps 1` to the segment encode args. Without it the output TS file inherits the source stream's absolute PTS (e.g. seeking to 402s → PTS ≈ 36M ticks at 90 kHz). When those segments are concatenated into MP4, iOS Safari sees an initial PTS of hundreds of seconds and refuses to play the file silently (video appears broken/black, server logs show repeated range-request cycles that abort after ~1 s).

**Why:** iOS Safari's H.264 decoder is strict about initial PTS. A valid-looking moov atom with a huge start timestamp is treated as an unsupported file, not a seek target.

**How to apply:** Add to every `ffmpeg` segment encode that outputs `-f mpegts`:
```
args.push("-reset_timestamps", "1");
args.push("-f", "mpegts", segPath);
```
The concat demuxer handles the resulting per-segment-0-based timestamps correctly, offsetting each subsequent segment by the previous segment's duration.
