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

**Stub-chunk pitfall:** ffmpeg's segment muxer can emit a final ~260-byte moov-only segment; uploading it poisons every future chunk existence probe (count off by one). Treat GCS chunk objects <10 KB as missing (self-heals stale stubs) and never upload a trailing stub.
