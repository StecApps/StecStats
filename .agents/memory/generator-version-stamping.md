---
name: Generator version stamping for cached derived media
description: Invalidate stale generated reels/proxies by stamping a version at "ready" and resetting stale-version rows on read.
---

Pattern: any derived media artifact (highlight reel, lowlight reel, playback proxy) that is cached in the DB as `status="ready"` must carry a generator version column stamped in the SAME update that sets ready. Bump the exported version constant whenever the generation logic changes in a way that makes old outputs wrong.

- On GET: if `status==="ready"` and `(version ?? 0) < CURRENT_VERSION`, reset status/path/error/startedAt to NULL in the DB and respond with the reset values — the UI naturally falls back to its "Generate" state. Idempotent under concurrent GETs; never touches `processing` rows, and completion stamps the version atomically, so a fresh build can't be clobbered.
- Chunked/cache intermediate objects (e.g. GCS proxy chunks) must namespace the version into their keys (`proxy_chunk_v${N}_...`) so old chunks can't be reused.

**Why:** Production complaint "NOTHING changed after publish" — reels generated with old buggy timing stayed ready forever; publishing new code alone can never fix already-generated artifacts.

**How to apply:** In hoops-stats: `GENERATOR_VERSION`/`PROXY_VERSION` in highlightGenerator.ts; columns on games/teams tables. When changing clip timing, encoding args, or output container, bump the constant — everything else is automatic (users see one Generate tap; proxies rebuild in background on next view).
