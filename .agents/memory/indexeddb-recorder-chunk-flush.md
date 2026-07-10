---
name: IndexedDB flushing for long MediaRecorder sessions
description: How to bound JS heap growth during long browser video recordings by flushing MediaRecorder chunks to disk instead of holding them in memory.
---

Holding all `MediaRecorder` `ondataavailable` blobs in an in-memory array (e.g. `chunksRef.current.push(blob)`) grows the JS heap unbounded for the whole recording duration. On a long session (tens of minutes) this can OOM-crash the tab, losing the recording and any in-memory app state that wasn't persisted elsewhere.

**Why:** A real user hit a ~50min recording crash from ~3.7GB of chunks retained in a ref array; nothing had been persisted until a final "Save" step, so both the video and unsaved stats were lost.

**How to apply:** Use a small IndexedDB helper keyed by `[sessionId, seq]` to write each chunk to disk as it arrives (`recorder.start(timeslice)` + `ondataavailable` → `saveChunk`), then reassemble via an ordered read (`getOrderedChunks`) on stop. Also lower `videoBitsPerSecond` to reduce total data volume. This bounds heap growth regardless of recording length. Pair with a separate lightweight autosave (see `autosave-recovery-draft.md`) for non-video state, since IndexedDB chunk flushing alone doesn't protect form/stats state from a crash — only the video.
