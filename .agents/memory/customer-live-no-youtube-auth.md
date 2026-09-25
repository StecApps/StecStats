---
name: Customer Live without YouTube setup
description: Product constraint for coach-facing Live and YouTube account ownership.
---

Customers must not be required to connect a Google/YouTube account to record or share a live game. StecStats Live uses the per-game Daily room, StecStats watch link, and cloud recording as the default. A connected YouTube channel is optional distribution for the owner's own workflow, not a prerequisite for coaches.

**Why:** The user explicitly rejected customer-managed YouTube setup as too much hassle. Requiring it for Live contradicted the intended product experience and would make concurrent customer games impractical.

**How to apply:** Treat YouTube relay errors as separate from Daily Live/recording errors. Never tell customers to connect their channel as a condition for starting a game. Preserve a clear warning if an explicitly connected optional relay fails, and test simultaneous streams separately before promising scale.