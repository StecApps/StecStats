---
name: Proxy transcode restart resilience
description: Why the proxy transcode must be split into GCS-checkpointed chunks and stream from GCS, not a single long ffmpeg process.
---

## The rule
Always transcode the proxy in short chunks (~6 min each). Upload each chunk to GCS immediately after it finishes. On restart, check GCS for existing chunks and skip them.
**Never download the source video to local disk** — for large files (2+ GB) the download alone takes longer than the restart window.

**Why:** Replit cycles the production container every ~8-10 min. A 2.8 GB fMP4 takes ~10 min to download before encoding can even start — that window is larger than the restart cycle, so the job never makes progress. Streaming directly from GCS via a signed URL gives ffmpeg data immediately with no upfront wait.

**How to apply:**
- `acquireGameProxy(gameId, ownerId)` in `highlightGenerator.ts` — no `srcPath` param.
  It queries `game.videoObjectPath`, calls `objectStorageService.getObjectEntitySignedURL(path, 4*3600)` to get a 4-hr signed URL, and passes that URL to `createChunkedProxy`.
- `createChunkedProxy(gameId, ownerId, srcPath, destPath, fileSizeBytes)` — `srcPath` can be a local path OR an HTTPS URL. `fileSizeBytes` is used for duration estimation fallback when probing a URL.
- **Seeking on URL source**: GCS signed-URL range requests are unreliable in production. For the first run (firstMissing=0) there is no seek — ffmpeg reads from byte 0 linearly (safe). For resume runs (firstMissing>0), place `-ss startSec` AFTER `-i` (slow/decode-and-discard seek), not before (which would issue a range request).
- Each chunk GCS path: `/objects/uploads/{ownerId}/proxy_chunk_{gameId}_{i}` (deterministic).
- Concat all chunks with `ffmpeg -f concat -c copy -movflags +faststart`.
- After the final proxy is uploaded to GCS and saved to DB (`videoProxyObjectPath`), future restarts download the completed proxy (~200-400 MB) instead of re-encoding.

**Orphan resume cutoff:** `resumeOrphanedJobs` in `index.ts` uses a 150-min window (matching STALE_PROCESSING_MS=140 min). `resumeHighlightJob`/`resumeLowlightJob` reset `started_at` to NOW so subsequent restarts see the job as fresh.
