---
name: Highlight/Lowlight OOM crash loop
description: Root causes and fixes for the infinite OOM restart loop when building proxy video for large games
---

## The problem
When highlight + lowlight auto-resume on a server restart, three bugs interact to create an infinite OOM loop:

1. **Shared AbortController map** — `generateHighlight` and `generateLowlight` both call `jobAbortControllers.set(gameId, ac)`. The second overwrites the first. `cancelHighlightGeneration` aborts the *last-set* controller, but the proxy download uses the *first* job's signal → Cancel never actually stops the download.

2. **DELETE set status to `null`** — if the server OOM-kills the process before the DB write commits, status stays `"processing"`. Next restart resumes it. The auto-resume query only picks up `processing` games, so setting `null` doesn't help when the process dies before the write.

3. **Unnecessary 1.3GB source download** — `acquireGameProxy` always downloads the source video before calling `createChunkedProxy`, even when all 6 proxy chunks already exist in GCS. This caused ~3GB concurrent disk usage (source + chunks + ffmpeg concat output) → disk exhaustion → OOM kill → status still `"processing"` → restart → repeat.

## How OOM kills create the loop
Node.js `SIGKILL` from OOM gives no cleanup time — no `finally`, no `catch`, no DB writes. If status is `"processing"` at kill time, it stays `"processing"` and `resumeHighlightJob` fires on the next restart unconditionally.

## Fixes applied
1. Split `jobAbortControllers` into `highlightAbortControllers` + `lowlightAbortControllers`. Export `cancelHighlightJob(gameId)` and `cancelLowlightJob(gameId)` separately. Highlight DELETE calls highlight cancel; lowlight DELETE calls lowlight cancel.

2. DELETE handlers now set status to `"failed"` (not `null`) with `error: "Generation was cancelled"`. `"failed"` is never picked up by the auto-resume query, so the loop breaks even through a crash.

3. In `acquireGameProxy`, before calling `acquireSourceVideo`, pre-check GCS chunk existence using `game.videoDurationMs` to estimate `numChunks`. If all chunks exist, call `createChunkedProxy` with `srcPath=""` and `durationHintMs=game.videoDurationMs` (skips ffprobe). The source download is skipped entirely.

4. Threaded `AbortSignal` into `createChunkedProxy` as an optional param, passed to each `downloadSourceVideo` call in the `allInGcs` branch, so Cancel stops mid-chunk-download.

## How to cancel a stuck game
Press the Cancel button under either the Highlight or Lowlight section. With these fixes:
- Cancel on highlight → `cancelHighlightJob` aborts highlight's signal → proxy download stops → both highlight and lowlight fail (shared proxy cache rejects) → both set `"failed"` → no auto-resume
- Cancel on lowlight → `cancelLowlightJob` aborts lowlight's signal → lowlight fails, but the shared proxy download (running under highlight's signal) continues → highlight may succeed or fail independently
- For the crash loop: cancel highlight (the first job to call `acquireGameProxy` owns the proxy download signal)
