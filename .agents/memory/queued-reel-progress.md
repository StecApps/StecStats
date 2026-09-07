---
name: Queued reel progress semantics
description: How media-worker queue time, encoding progress, and lease takeover should be represented.
---

Represent a reel waiting for a media-worker slot as `queued`, with no encoding start time or progress counters. Change it to `processing` only after the run-token owner acquires a slot. Persist only server-observed work units (proxy chunks, rendered clips, finalization), and reset progress atomically whenever a new run token is claimed.

**Why:** Queue time is not encoding progress, elapsed time is not completed work, and carrying counters across lease takeover makes a new worker appear further along than it really is.

**How to apply:** Status APIs and polling UIs treat `queued` and `processing` as active, display only persisted stage counters, fence every progress write by run token, and clear/finalize counters on all terminal and invalidation paths.