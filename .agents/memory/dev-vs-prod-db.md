---
name: Dev vs prod database are separate (hoops-stats / stecstats)
description: The published site uses its own database; how to backfill imported data to production.
---

The published stecstats site (stecstats.replit.app / stecstats.stecco.org) uses a **separate production database** from the dev environment. Publishing deploys code, NOT dev data — data created or imported in dev does not appear on the live site.

**To backfill stats onto the live site:** POST the same import payload to the PRODUCTION api URL, e.g. `https://stecstats.replit.app/api/import` (the `/api/import` endpoint is idempotent — find-or-create by name/date, so re-running is safe and won't duplicate). Verify with `GET https://stecstats.replit.app/api/players/<id>/summary`.

**Why this matters:** when the user asks to "push X to the site," check prod separately — prod may already have some data (e.g. players existed in prod but with 0 games) while dev has the full set. Don't assume dev == prod.
