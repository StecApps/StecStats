---
name: Debounced localStorage autosave + recovery dialog
description: Pattern for protecting lightweight in-progress form/stats state against tab crashes, independent of any heavy media pipeline.
---

For a long-running data-entry flow (e.g. live stat tracking during a recording) that previously only persisted on a final "Save" action, add a debounced (~1s) autosave of the *lightweight* state (ids, scores, counters, timestamps — not blobs) to `localStorage`, gated to only fire once there's real content (avoids clobbering a not-yet-reviewed recovery draft with an empty draft on mount).

**Why:** A crash mid-session (OOM, browser close, refresh) loses everything held only in React state. Video/blob data needs a different mechanism (IndexedDB chunk flush — see `indexeddb-recorder-chunk-flush.md`) since it's too large for localStorage, but form/stats state is cheap enough to snapshot on every change.

**How to apply:** On mount, check for an existing draft newer than a max-age cutoff (e.g. 24h) with non-trivial content, and show a "Resume unsaved game?"-style dialog *before* the autosave effect can run again — otherwise the effect may overwrite the pending draft with blank state before the user decides. Wire "Resume" to rehydrate state via setters (and optionally attempt to reattach any IndexedDB-backed media session), and "Discard" to clear the storage key. Clear the draft key on successful final save. This pattern is orthogonal to and independent of any camera/video pipeline — it can and should be e2e-tested without needing real camera access, since it only depends on form state changes.
