---
name: Reel generation on RAM-backed /tmp — chunk-based extraction
description: Why highlight/lowlight jobs must never build the full local proxy, and the invariants of the chunk-based design
---

# Reel generation must stay chunk-based (never build the full proxy locally)

**Rule:** In production, `/tmp` is RAM-backed tmpfs (~2 GB budget). Any reel/video job that downloads all proxy chunks and concatenates them locally (~1.4 GB for a 34-min game, ~2x peak with the concat output) gets SIGKILLed. OOM SIGKILL gives no cleanup time (no `finally`, no DB writes), so job status stays `processing`, auto-resume fires on next boot, and the server enters an infinite OOM restart loop.

**Design invariants (do not regress):**
- Reel extraction works directly from individual ~250 MB / 360 s proxy chunks in GCS (`proxy_chunk_v{PROXY_VERSION}_{gameId}_{i}`), holding at most 2 chunks locally (boundary-spanning segments use a 2-entry concat-demuxer list). Peak ≈ 550 MB per job (~1 GB when highlight+lowlight run concurrently).
- Chunk ensure is single-flight per game — highlight + lowlight start the same millisecond and would otherwise double-download the source.
- The true chunk count comes from what ffmpeg actually produced, never the duration estimate; discovery over-probes GCS past the guess until first miss.
- Team highlights process games sequentially, never `Promise.all` — one game's chunks are bounded but N games in parallel are not.
- `buildSegments` caps segment length (MAX_SEGMENT_SEC=300) so one corrupt event timestamp can't create an unbounded clip.
- The only remaining full-proxy builder (film-room playback proxy) is size-gated: skip games >900 s or unknown duration. Accepted tradeoff: long WebM-recorded games play the raw source, which iOS Safari may not handle.
- Cancel/DELETE handlers set status `"failed"` (never `null`) so auto-resume can't re-trigger a crashed job even if the process died before a cleanup write.
- Highlight and lowlight keep SEPARATE AbortController maps — a shared map made Cancel abort the wrong job's signal.

**Critical: never fall back to raw source when chunks are confirmed in GCS.**
GCS chunk downloads in production can be extremely slow (~80 KB/s observed — 278 MB chunk takes ~1 hour). If the per-process timeout (30 min) fires during chunk extraction AND chunks are confirmed in GCS, the handler must throw a clean HighlightError ("Please try again") and stop — NOT start downloading the 1.36 GB raw source. Two concurrent raw-source downloads = 2.7 GB on a 2 GB tmpfs = OOM. Track this with a `chunksConfirmed` flag set after `ensureProxyChunksInGcs` returns successfully; check it before every raw-source fallback.

**GCS download speed is the bottleneck for long games.** A 34-min game with 6 ×~250 MB chunks at 290 KB/s average = 86+ min of downloads for two concurrent jobs (highlight + lowlight), far over the 30-min per-process timeout. Two fixes address this:

1. **Skip empty chunks using nominal boundaries.** Pre-compute `neededChunks = Set<number>` from segment timestamps ÷ `PROXY_CHUNK_DURATION_SEC`. Advance `chunkStart` by the nominal duration for skipped chunks (≤2 s drift per skip — negligible for PRE=12 s clips). For game 161: moments are only in chunks 1, 3, 4 — saves 3 wasted downloads per job.

2. **Module-level shared chunk cache (`_sharedChunkCache`).** Highlight and lowlight share downloaded files by GCS object path. Ref-counted: file deleted only when last job releases it. Do NOT pass job-specific AbortSignal to the shared download — cancel one job without aborting the sibling's in-flight download. Combined effect: 3 unique downloads (shared) that run partially in parallel (highlight grabs chunk 3, lowlight grabs chunk 1 simultaneously) → ~29 min wall time instead of 86+ min.

3. **Skip per-file ffprobe probes for chunked mode.** Proxy chunks are always 720p H264+AAC with no rotation tag. Hardcode rawWidth=1280, rawHeight=720, transposeFilter=null, hasAudio=true. Also skip `ensureChunk(0)` for initial probe — that was downloading chunk 0 just for video metadata even when it had no moments.

4. **Eliminate ALL ffprobe calls from the chunk walk.** The original `chunkDuration(ci)` call ran ffprobe on each chunk to get its duration. This ffprobe runs under `nice -n 10` and can hang for the full 1800s PROCESS_TIMEOUT_MS when the system is CPU-saturated by concurrent GCS downloads + sibling ffmpeg clip renders. Fix: use `PROXY_CHUNK_DURATION_SEC` (nominal) as the duration for every non-last needed chunk; derive last-chunk duration from `knownDurationMs`. Drift ≤ keyframe interval (~1–2 s per chunk) — negligible for PRE_SECONDS=12 clips. This also makes chunk downloads completely lazy: the first `ensureChunk(ci)` call inside the segment while-loop triggers the download (not before).

**Stub-chunk pitfall:** ffmpeg's segment muxer can emit a final ~260-byte moov-only segment; uploading it poisons every future chunk existence probe (count off by one). Treat GCS chunk objects <10 KB as missing (self-heals stale stubs) and never upload a trailing stub.
