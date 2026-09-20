---
name: YouTube auto-start schedule requirement
description: YouTube Live API validation required for immediate encoder broadcasts.
---

YouTube `liveBroadcasts.insert` requires `snippet.scheduledStartTime` even when `contentDetails.enableAutoStart` is enabled for an immediate encoder stream. Supply a timestamp slightly in the future to avoid clock-skew rejection.

**Why:** A real enabled channel rejected broadcast creation with “Scheduled start time is required”; types and local checks did not expose the provider-side requirement.

**How to apply:** Keep a focused request-shape regression test around broadcast creation. Auto-start controls transition behavior after ingestion begins, but it does not make the scheduled timestamp optional.