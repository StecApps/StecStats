---
name: Premium tier entitlements
description: How the three-tier plan (free/pro/premium) is determined from Stripe data and wired into billing checkout.
---

## Rule
- `plan = "premium"` when the user has an active Stripe subscription whose price belongs to a product with "premium" in the name (case-insensitive).
- `plan = "pro"` for any other active subscription.
- `plan = "free"` when no active subscription exists.

## How entitlements determine tier
`getEntitlements()` in `entitlements.ts` does a single SQL join:
```sql
stripe.subscriptions → stripe.subscription_items → stripe.prices → stripe.products
```
It reads `prod.name` and checks `productName.includes("premium")`. If the join returns no product (e.g. si/prices tables empty), falls back to "pro" for any active sub.

**Why:** stripe-replit-sync syncs `subscription_items`, `prices`, and `products` tables. Joining at query time avoids caching a price ID in env vars and works regardless of environment (dev/prod Stripe products differ).

## Billing checkout wiring
`POST /billing/checkout` body now accepts `{ interval, tier? }` where `tier` defaults to `"pro"`.
- `tier = "premium"` → searches Stripe for product name `"STECSTATS Premium"` (exact, case-sensitive Stripe search)
- `tier = "pro"` → searches for `"STECSTATS Pro"`

**How to apply:** When adding a new Premium price in Stripe, name the product exactly "STECSTATS Premium" (no space between STEC and STATS) — the checkout route does an exact name match via Stripe product search API. Live prices as of Jul 2026: $9.99/month, $79.00/year.

## Frontend
- `billingStatus.plan` can now be `"free" | "pro" | "premium"`.
- `isPremium = plan === "premium"` in dashboard.tsx gates the player tracking photo UI.
- `isPro = plan === "pro" || plan === "premium"` so Premium users also get all Pro features.
- Billing page shows three-column grid: Free / Pro / Premium.

## Owner override
`OWNER_CLERK_EMAIL` now grants Premium (not Pro) to the designated owner.
