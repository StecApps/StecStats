---
name: Split/pause recording segment loss must be loud
description: Half/segment flush failures during recording were silently dropped; always toast + keep IndexedDB session.
---

The record page's "Start 2nd Half" (splitRecording) and Pause (pauseRecording) flows stop the current MediaRecorder, read chunks back from IndexedDB, and push the assembled Blob into `recordedSegments`.

**Rule:** if chunk read-back fails or returns 0 chunks, the segment must NOT be silently skipped. Show a destructive toast immediately and keep the IndexedDB session (do not delete it) so recovery is possible.

**Why:** a real user game lost its entire second half with no warning — the user only discovered it weeks later when the film room "broke" on second-half plays. Silent `resolve(null)` + `if (blob)` skip was the failure mode.

**How to apply:** any new code path that flushes recorder chunks into a segment list must (1) treat empty/zero-size blobs as failure, (2) toast loudly, (3) preserve the IndexedDB session on failure. The missing-footage transparency feature (onFilmMoments / "Not on film") is the backstop, not the first line of defense.
