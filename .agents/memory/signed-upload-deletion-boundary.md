---
name: Signed upload deletion boundary
description: Preventing signed direct-upload URLs from recreating account media after deletion.
---

When account-scoped media uses direct signed upload URLs, persist the exact
absolute expiry used to sign each capability. Account deletion must first
durably block new capabilities, then wait through the recorded expiry before
its final namespace sweep. Re-check account state after placeholder setup and
clean it up if deletion won the race.

**Why:** A signed cloud-storage PUT is independent of subsequent application
authorization checks. A URL issued just before deletion can otherwise write
private media after the deletion sweep has already completed.

**How to apply:** Derive the database reservation and the signed URL from one
absolute timestamp, never separate relative TTL calculations. Treat placeholder
creation and signing as a race with deletion and add an interleaving test for
that boundary.