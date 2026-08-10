---
name: Replit Clerk live vs test instance split — mobile auth
description: Replit auto-swaps CLERK_PUBLISHABLE_KEY to a live Clerk instance on publish. Mobile app has the test key baked in at build time. Server-side JWKS fallback bridges the gap.
---

## The Problem

**Replit auto-swaps `CLERK_PUBLISHABLE_KEY` (and `VITE_CLERK_PUBLISHABLE_KEY`) to a live Clerk instance key on publish.** The server's `clerkMiddleware()` uses the live JWKS and expects `iss: <live-instance>`. The TestFlight binary was built with the test key (`pk_test_...`, `immortal-swan-47.clerk.accounts.dev`) baked in — mobile tokens carry `iss: https://immortal-swan-47.clerk.accounts.dev` → rejected.

Web sessions work fine (cookies bypass JWKS verification). Only Bearer token (mobile) requests fail.

## The Workaround (in place, no new app build required)

`requireAuth.ts` has a fallback: when `clerkMiddleware()` rejects a Bearer token, fetch JWKS directly from the JWT's own `iss` URL, build a PEM, and call `verifyToken(token, { jwtKey: pem })`.

**Trust check:** only fetch JWKS from `*.clerk.accounts.dev` (Clerk-controlled infrastructure). Cryptographic signature verification is the real security gate.

```typescript
const isClerkHostedInstance = /^https:\/\/[a-z0-9-]+\.clerk\.accounts\.dev$/.test(iss);
```

**Do NOT** derive the trusted FAPI host from `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`. In production that variable holds the LIVE key (decoding to something like `clerk.stecstats.stecco.org`), not the test key the mobile binary was built with. The iss mismatch would cause all mobile requests to fail.

## JWKS cache

5-minute in-memory cache keyed by `iss`. Lives in the module scope of `requireAuth.ts`. Survives across requests but resets on server restart.

## Diagnostic signature

- `requireAuth: 401 — JWT payload` + `jwtIss: "https://immortal-swan-47.clerk.accounts.dev"` in PRODUCTION logs
- `trust check failed — trustedFapi="clerk.stecstats.stecco.org"` means the EXPO key decoding was being used incorrectly as the trust anchor
- Web sessions work fine; only Bearer token (mobile) requests fail

## Permanent fix

Rebuild the mobile app (`eas build --platform ios --profile production --local`) with the live Clerk publishable key so both app and server use the same instance. The live key isn't surfaced easily in Replit — user must find it in the Clerk dashboard for the live tenant. EAS cloud quota exhausted until Sep 1; local builds only.
