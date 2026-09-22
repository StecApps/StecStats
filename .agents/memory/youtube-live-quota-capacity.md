---
name: YouTube Live quota capacity
description: Current YouTube Data API quota costs and how to diagnose unexpected exhaustion.
---

A complete StecStats YouTube Live session costs about 250 shared YouTube Data API units: broadcast insert, video update, stream insert, bind, and transition are 50 each. Read-only list and channel probes cost 1. Since June 2026, `videos.insert` uses a separate granular upload bucket rather than consuming the shared 10,000-unit allocation.

**Why:** The default shared allocation should support roughly 40 complete Live sessions per quota day. Production exhausted quota after only a few successful sessions, so normal Live usage was not sufficient to explain it; likely causes are a reduced project limit or another workload sharing the Google Cloud project.

**How to apply:** Count persisted broadcasts and streams for the Pacific-time quota day before blaming retries. Verify the actual limits and usage by quota bucket in Google Cloud Console because a YouTube user OAuth token does not expose project quota usage. Daily quota resets at midnight Pacific Time.