---
name: Cueless WebM clip extraction from GCS
description: How to cut highlight clips from large live-recorded WebM in GCS — event-derived pseudo-duration + one linear stream-copy pass; never proxy-transcode or per-clip seek.
---

## The rule
For remote (GCS signed URL) sources, cut clips in two phases:
- **Phase A**: ONE ffmpeg invocation reads the URL linearly and stream-copies every clip window to a small local intermediate: per output `-map 0 -c copy -ss winStart -to end -avoid_negative_ts make_zero win_i.mkv`. No decode — runs at network/demux speed and stops after the last `-to`.
- **Phase B**: precise caption/watermark encode from each intermediate using a RELATIVE seek (`seg.start - winStart`), since ffmpeg shifts output-seek copy timestamps so each intermediate has `start_time=0` (empirically verified).

**Why:** MediaRecorder live-recorded WebM has no duration header and no Cues index. Every remote `-ss` is a linear scan from byte 0 (O(clips × filesize)); duration probes all return N/A; VBR makes bitrate estimates wildly wrong (measured 4x error). A full proxy transcode decodes hours of VP9 (~0.5x realtime = hours of work) for a few minutes of clips. The old chunked-proxy approach is obsolete — no game ever actually needed it.

**How to apply:**
- Duration surrogate for segment building: `max(event timestamp) + POST_SECONDS + 60` — duration is only used to clamp windows. After Phase A, drop windows whose file is < 20 KB (event past true EOF).
- Keyframe pre-pad: MediaRecorder VP9 keyframes are ~2s apart; a 6s pad before clip start is safe.
- Measured on 2-core container: linear read ≈ 10-15 MB/s through ffmpeg (URL input and SDK-stream-to-stdin pipe are equally fast — CPU-bound, not network); a 3 GB pass ≈ 4-6 min. Give the pass a 30-min timeout.
- Probing dims/rotation/audio from the URL is fine — WebM Tracks are in the header (fast reads).
- Local-file sources keep the old absolute-seek path; only URL sources go through Phase A.
