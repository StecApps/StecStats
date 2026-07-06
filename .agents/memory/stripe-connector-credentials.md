---
name: Stripe connector credential field names
description: Correct field names when reading Stripe secrets from the Replit connection API (differs from generic skill template).
---

The Replit Stripe connector's `/api/v2/connection` response `settings` object
uses `secret` (a string, the live/test secret key itself) and
`publishable`, NOT `secret_key` as shown in some generic template docs.
`webhook_secret` may be absent/undefined in `settings` for a fresh
connection — treat it as optional and let `StripeSync` manage the webhook
secret internally via `findOrCreateManagedWebhook`.

**Why:** Copying the stripe skill's `stripeClient.ts` template verbatim
(`settings.secret_key`) causes `getUncachableStripeClient()` /
`getStripeSync()` to always throw "missing secret key" even though the
connector is properly connected — cost real debugging time.

**How to apply:** When wiring `stripeClient.ts` (API server + scripts copy),
read `settings.secret` for the Stripe secret key, not `settings.secret_key`.
Verify by hitting the connection endpoint directly and logging
`Object.keys(settings)` (never log the values) if in doubt.
