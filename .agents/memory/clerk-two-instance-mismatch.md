---
name: Two Clerk instances — mobile vs server mismatch
description: Mobile was configured with a user-created live Clerk instance (stecco.org); server uses the Replit-managed instance (immortal-swan-47). Tokens from different instances can't be verified cross-instance.
---

## The Rule
Mobile and server must use the **same** Clerk instance. The Replit-managed instance is `immortal-swan-47.clerk.accounts.dev` with publishable key `pk_test_aW1tb3J0YWwtc3dhbi00Ny5jbGVyay5hY2NvdW50cy5kZXYk`. The server's `CLERK_SECRET_KEY` matches this instance.

## What Went Wrong
`eas.json` production profile had a hardcoded user-created live key (`pk_live_Y2xlcmsuc3RlY3N0YXRzLnN0ZWNjby5vcmck`) for a separate Clerk instance (`clerk.stecstats.stecco.org`). That domain had no DNS CNAME so Clerk never initialized (isLoaded=false, button silently did nothing). When a proxy workaround was added, Clerk loaded but tokens were rejected by the server because the CLERK_SECRET_KEY belongs to the Replit-managed instance, not the user's custom one.

**Why:** `@clerk/express` `clerkMiddleware()` uses the CLERK_SECRET_KEY to determine which instance's JWKS to verify tokens against. Tokens from a different instance have a non-matching iss and signature — they're always rejected with 401.

## How to Apply
- Always decode the publishable key to confirm which FAPI it targets: `Buffer.from(key.replace(/^pk_(test|live)_/, ''), 'base64').toString()`
- The correct mobile key for EAS builds is `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` from the Replit environment (immortal-swan-47 instance).
- `immortal-swan-47.clerk.accounts.dev` resolves in DNS — no proxy needed for mobile.
- Never hardcode a user-created Clerk live key in `eas.json` unless the server's CLERK_SECRET_KEY also belongs to that instance.
