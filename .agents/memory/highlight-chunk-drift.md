---
name: Proxy chunk keyframe drift and lead-in clipping
description: How default GOP size in libx264 causes cumulative chunkStart error that strips lead-in from highlight clips, and how to fix it.
---

## The rule
Always encode proxy chunks with `-force_key_frames "expr:gte(t,n_forced*2)"`. Without it, the default 250-frame GOP (≈8 s at 30 fps, ≈4 s at 60 fps) causes each chunk to exceed the nominal `PROXY_CHUNK_DURATION_SEC` by up to one keyframe interval. When n chunks are skipped before the first needed chunk, the cumulative chunkStart error is n × keyframe_interval, which directly eats into the `PRE_SECONDS` lead-in window.

## Why
Game 161 had 3 skipped proxy chunks (highlight only needed chunks 3 and 4 out of 6). With a ~4 s keyframe interval and 3 skipped chunks, cumulative drift = 12 s = exactly PRE_SECONDS (12 s). Result: the first basket clip started right on the basket moment with zero lead-in. The user saw the basket + and-one + free throw but no lead-in of the drive.

## How to apply
- Proxy encoding (highlightGenerator.ts): include `-force_key_frames "expr:gte(t,n_forced*2)"` in ffmpegArgs whenever using `-f segment` muxer. Max drift per chunk = 2 s.
- PRE_SECONDS: set to at least `max_skippable_chunks × 2 + desired_lead_in`. Currently PRE_SECONDS=18 gives ≥12 s guaranteed lead-in even with 3 skipped chunks at 2 s/chunk.
- PROXY_VERSION: bump whenever the proxy encoding changes so existing chunks get re-encoded. Highlight generator waits for proxy rebuild automatically.

## Calibration used
- PROXY_VERSION 3: -force_key_frames every 2 s (≤2 s drift per chunk)
- PRE_SECONDS 18: covers 3 skipped × 2 s/chunk = 6 s drift + 12 s actual lead-in
- GENERATOR_VERSION 5: bumped alongside PRE_SECONDS change so any cached reel is invalidated
