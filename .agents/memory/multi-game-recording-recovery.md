---
name: Multi-game recording recovery
description: Why iPad recording recovery must preserve several unfinished games independently.
---

Each completed iPad recording needs its own durable recovery identity. Saving another game must never replace or clear an earlier game's unfinished upload; a stats-only save must not remove recoverable video.

**Why:** Coaches may run several games in one day while a previous recording is still uploading or the iPad is offline. A single global marker let the later game overwrite the earlier one's local movie references, making footage impossible to recover after a relaunch.

**How to apply:** Treat pending masters as a per-game queue keyed by stable client ID, and remove only the entry whose video attachment was confirmed. Keep reads compatible with markers written by older installed builds. Test two consecutive recorded games with a relaunch and partial upload failure.