---
name: Proxy chunk keyframe drift and lead-in clipping
description: How default GOP size in libx264 causes cumulative chunkStart error that strips lead-in from highlight clips, and how to fix it.
---

## The rule
Always encode proxy chunks with `-force_key_frames "expr:gte(t,n_forced*2)"`. Without it, the default 250-frame GOP (≈8 s at 30 fps, ≈4 s at 60 fps) causes each chunk to exceed the nominal `PROXY_CHUNK_DURATION_SEC` by up to one keyframe interval. When n chunks are skipped before the first needed chunk, the cumulative chunkStart error is n × keyframe_interval, which directly eats into the `PRE_SECONDS` lead-in window.

## Why
Game 161 had 3 skipped proxy chunks (highlight only needed chunks 3 and 4 out of 6). With a ~4 s keyframe interval and 3 skipped chunks, cumulative drift = 12 s = exactly PRE_SECONDS (12 s). Result: the first basket clip started right on the basket moment with zero lead-in. The user saw the basket + and-one + free throw but no lead-in of the drive.

## How to apply
- Proxy encoding (highlightGenerator.ts): use `-g 60 -keyint_min 60 -sc_threshold 0` when using `-f segment` muxer. Max drift per chunk = 2 s at 30 fps, 1 s at 60 fps.
- PRE_SECONDS: set to at least `max_skippable_chunks × 2 + desired_lead_in`. Currently PRE_SECONDS=18 gives ≥12 s guaranteed lead-in even with 3 skipped chunks at 2 s/chunk.
- PROXY_VERSION: bump whenever the proxy encoding changes so existing chunks get re-encoded. Highlight generator waits for proxy rebuild automatically.

## GCS single-stream download throttle + slow CPU proxy encoding
Two compounding issues cause 90-min timeouts on long games (>20 min):
1. GCS throttles each stream: starts ~4 MB/s, drops to ~0.24 MB/s (1.36 GB = 94 min single-stream).
   Fix: parallel byte-range downloads (PARALLEL_DOWNLOAD_CONCURRENCY=4, PARALLEL_RANGE_BYTES=64MB).
   Each range gets its own burst window; pre-allocate with fs.truncate then write at offset
   using createWriteStream(path, { start, flags: 'r+' }). Small files (<200 MB) stay single-stream.
2. Production CPU encodes VP8→H.264 at ~0.35× real-time; a 33-min game takes ~94 min → timeout.
   Fix: doEnsureProxyChunksInGcs throws HighlightError for videos >1200s (20 min) when chunks
   aren't already in GCS. This triggers the fallback: parallel download + direct source extraction
   (~10 min total vs 90+ min with proxy). Short games (≤20 min) still use the proxy path.

## What NOT to use
`-force_key_frames "expr:gte(t,n_forced*2)"` evaluates the expression PER FRAME. On this server it dropped encoding speed from ~5× real-time to ~0.3× real-time (33 min to encode a 6-min chunk; 6 chunks = 3.5 h). Never use this flag for proxy encoding.

## Calibration used
- PROXY_VERSION 4: -g 60 -keyint_min 60 -sc_threshold 0 (≤2 s at 30fps, ≤1 s at 60fps drift per chunk; fast frame-count evaluation)
- PRE_SECONDS 18: covers 3 skipped × 2 s/chunk = 6 s drift + 12 s actual lead-in
- GENERATOR_VERSION 5: bumped alongside PRE_SECONDS change so any cached reel is invalidated
