---
name: Master game-film retention
description: Durable rules for recording upload, recovery, derivative generation, and deletion boundaries.
---

The full recorded game is the master asset. Highlight, Lowlight, proxy, and HLS files are replaceable derivatives and must never be treated as the only copy.

**Why:** Native recording and recovery have several asynchronous boundaries—offline completion, upload, game creation, attachment, app termination, and reel generation. Clearing local footage or deleting the server master at any earlier boundary can permanently lose an important game.

**How to apply:** Persist a stable pending-master record before upload; serialize foreground and recovery workers; retain local URIs until the server confirms owner-scoped attachment; trigger derivatives only after attachment. Protect every attached, replaced, merged, or repaired master in a durable retention ledger before changing game linkage. Normal game deletion and generic cleanup may remove derivatives but not masters. Explicit authenticated account deletion/privacy erasure is the retention exception.