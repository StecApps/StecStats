---
name: Chunk-boundary lead-in clipping
description: When a highlight segment's PRE_SECONDS lead-in crosses a proxy chunk boundary, the seek clamps to 0 and drops up to 12s of footage from the start of the clip.
---

## The rule
When `seg.start` (= event timestamp − PRE_SECONDS) falls in chunk `ci-1` but the segment's body/end is in chunk `ci`, do NOT use `Math.max(0, seg.start - chunkStart)` as the seek. That clamps to 0, making ffmpeg start at the chunk boundary and silently dropping the lead-in footage.

Instead, detect `leadInInPrevChunk = seg.start < chunkStart && ci > 0` and use the concat-demuxer path: feed `[chunk ci-1, chunk ci]` as input with `localSeek = seg.start - (chunkStart - PROXY_CHUNK_DURATION_SEC)`.

**Why:** Proxy chunks are 360s each. Any event in the first 12 seconds of a chunk has its 12s lead-in in the previous chunk. The original code only handled end-boundary spans (clip end in ci+1), not start-boundary spans (clip start in ci-1). This caused the first ~10-12s to be missing from clips near chunk boundaries — reported as "the first shot had no lead-up footage".

**How to apply:** The fix is already in highlightGenerator.ts (GENERATOR_VERSION 3). Any future changes to PRE_SECONDS or the chunk walk must preserve this `leadInInPrevChunk` branch. The `neededChunks` set calculation is already correct (uses `seg.start` which includes the lead-in) so chunk ci-1 will always be downloaded when needed.
