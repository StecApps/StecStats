---
name: stripe-replit-sync migration race on first boot
description: First app boot can hit "relation stripe.accounts does not exist" even though runMigrations() didn't throw; how to diagnose and confirm the fix.
---

`stripe-replit-sync`'s `runMigrations({ databaseUrl })` connects with its own short-lived `pg.Client`, creates the `stripe` schema, and runs numbered SQL migrations (including creating `stripe.accounts` around migration 0046). On a from-scratch schema, the very first automatic boot can log an error like:

```
error: relation "stripe.accounts" does not exist
Failed to lookup account by API key hash, falling back to API
Failed to upsert account to database
```

...even though `runMigrations()` itself did not throw or log a migration failure. Re-running the exact same `initStripe()` sequence (or a plain workflow restart) after this occurs succeeds cleanly with all ~29 `stripe.*` tables present.

**Why:** Likely a first-boot race/timeout between the migration connection and StripeSync's account-lookup connection when the schema is being created for the very first time; not a code bug in this repo.

**How to apply:** If you see this specific error only on the *first* boot after wiring up Stripe, don't assume the migration code is broken — verify via `SELECT tablename FROM pg_tables WHERE schemaname='stripe'` (or write a small one-off script calling `runMigrations` directly with a `logger`) to confirm tables exist, then just restart the workflow. If the error persists after a clean restart with tables confirmed present, then dig further.
