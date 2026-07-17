---
name: Proxy transcode restart resilience
description: Why the proxy transcode must be split into GCS-checkpointed chunks, not a single long ffmpeg process.
---

## The rule
Always transcode the proxy in short chunks (~6 min each). Upload each chunk to GCS immediately after it finishes. On restart, check GCS for existing chunks and skip them.

**Why:** Replit deploys replace the entire container — every child process (including ffmpeg) receives SIGTERM. A single 35-min ffmpeg job is reset to zero on every deploy. With 6-min chunks, a restart costs ≤6 min of progress.

**How to apply:**
- `createChunkedProxy(gameId, ownerId, srcPath, destPath)` in `highlightGenerator.ts` implements this.
- Each chunk GCS path: `/objects/uploads/{ownerId}/proxy_chunk_{gameId}_{i}` (deterministic, no UUID).
- `objectStorageService.checkObjectEntityExists(path)` — non-throwing existence check.
- `objectStorageService.uploadLocalFileToObjectPath(local, path, ct)` — upload to deterministic path.
- Concat all chunks with `ffmpeg -f concat -c copy -movflags +faststart` (fast, no re-encode).
- Each chunk has a 12-min ffmpeg timeout; concat has 10-min timeout.
- After the final proxy is uploaded to GCS and saved to DB (`videoProxyObjectPath`), future restarts just download the completed proxy — chunks are no longer needed.
