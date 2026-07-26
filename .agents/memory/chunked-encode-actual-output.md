---
name: Chunked encodes must complete on actual output
description: Restart-resilient chunked transcode pipelines must derive completion from segments actually produced, never from a duration estimate.
---

The rule: in a chunked/segmented ffmpeg pipeline, the estimated chunk count (from a duration probe) may only be used for resume bookkeeping (which chunks already exist). Loop exit, concat set, and "build complete" must be derived from the segments ffmpeg actually wrote (the segment-list file), plus the already-existing chunks.

**Why:** Live-recorded cueless WebM defeats ffprobe's duration stages, so the pipeline falls back to filesize ÷ assumed-bitrate. A real prod file recorded at ~11.8 Mbps was estimated with a 3 Mbps assumption → 4x overestimated duration → the upload loop waited for chunks that would never exist and hung forever; every restart resumed by seeking past end-of-file and hung again.

**How to apply:**
- Exit condition: `ffmpegDone && uploadedAll(actualSegmentList)`, never `>= estimatedCount`. Capture the done flag BEFORE reading the segment list so the list is at least as fresh as the flag.
- After encode: `actualChunks = firstMissing + producedSegments`; 0 produced with firstMissing > 0 means a prior overestimate — the existing chunks are the complete set; 0 total → throw.
- Pass the container-probed duration (games.videoDurationMs, from WebM last cluster timecode / MP4 mvhd) as a hint so the estimate is right in the first place.
- Note: seeking past EOF may still emit one near-empty segment that gets concatenated — harmless.
- Related: an underestimate whose extra chunks already sit in GCS could make the all-in-GCS fast path concat a truncated proxy; if a "short proxy" report appears, check stored duration vs real file.
