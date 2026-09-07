---
name: Queued reel progress semantics
description: How media-worker queue time, encoding progress, and lease takeover should be represented.
---

Represent a reel waiting for a media-worker slot as `queued`, with no encoding start time. Change it to `processing` and set the start time only after the run-token owner acquires a slot. An expired lease takeover must return to `queued` before starting a fresh progress clock.

**Why:** Queue time is not encoding progress. Reusing an old or pre-slot timestamp makes progress appear frozen or falsely advanced, especially after cross-instance recovery.

**How to apply:** Any reel status API, polling UI, lease heartbeat, cancellation path, or startup recovery query must treat both `queued` and `processing` as active, while progress estimates must use only the `processing` start time.