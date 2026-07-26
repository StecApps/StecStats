---
name: Boot-time data fixes must be conditional
description: Seed-style production data fixes (applied on every boot because prod DB is read-only from dev) must not overwrite later manual edits.
---

The rule: boot-time data fixes (the seed.ts `applyVideoOffsetFixes` pattern used because the prod DB can't be written from dev) must guard on the column still being NULL (or still holding the old broken value), never unconditionally SET on every boot.

**Why:** The app exposes some of these columns in the UI (e.g. the per-game video offset field). An unconditional boot fix silently reverts the user's manual adjustment on every deploy/restart — a frustrating, hard-to-diagnose regression for the user.

**How to apply:** `UPDATE ... WHERE id = X AND col IS NULL` (drizzle: `and(eq(id), isNull(col))`), log only when a row was actually updated, and keep fixes in a declarative table so each new game repair is one entry.
