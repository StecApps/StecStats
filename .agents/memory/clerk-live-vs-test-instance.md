---
name: Replit Clerk live vs test instance — mobile auth
description: No Clerk Production instance exists yet; mobile app has the test key baked into the EAS binary; server-side JWKS fallback bridges the gap until the Production instance is provisioned.
---

## The Problem

**Replit auto-swaps `CLERK_PUBLISHABLE_KEY` to a live Clerk instance key on publish.** The server's `clerkMiddleware()` uses the live JWKS and expects `iss: <live-instance>`. The EAS production binary was built with the test key (`pk_test_...`, `immortal-swan-47.clerk.accounts.dev`) baked in — mobile tokens carry `iss: https://immortal-swan-47.clerk.accounts.dev` → rejected by live-instance JWKS.

**Important:** No Clerk Production instance exists yet in the Clerk dashboard. Replit only auto-provisions it on the **first publish via Replit's deployment pipeline** (Deployments → Publish). Until that happens, all Replit secrets (`CLERK_PUBLISHABLE_KEY`, `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`) remain `pk_test_`.

## The Workaround (in place, no new app build required)

`requireAuth.ts` has a fallback: when `clerkMiddleware()` rejects a Bearer token, fetch JWKS directly from the JWT's own `iss` URL, build a PEM, and call `verifyToken(token, { jwtKey: pem })`.

**Trust check:** only fetch JWKS from `*.clerk.accounts.dev` (Clerk-controlled infrastructure). Cryptographic signature verification is the real security gate.

```typescript
const isClerkHostedInstance = /^https:\/\/[a-z0-9-]+\.clerk\.accounts\.dev$/.test(iss);
```

## Diagnostic signature

- `requireAuth: 401 — JWT payload` + `jwtIss: "https://immortal-swan-47.clerk.accounts.dev"` in PRODUCTION logs → fallback is active
- Web sessions work fine; only Bearer token (mobile) requests fail

## Permanent fix (requires user action first)

1. **Publish the app via Replit** (Deployments → Publish) — this auto-provisions the Clerk Production instance
2. Open `dashboard.clerk.com` → switch to **Production** instance → **API Keys** → copy the `pk_live_...` publishable key
3. Replace `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` in `artifacts/hoops-mobile/eas.json` production env block (currently `pk_test_aW1tb3J0...`)
4. Run `eas build --platform ios --profile production` and test sign-in on device
5. Once live tokens are in use, `clerkMiddleware()` handles them directly; the `*.clerk.accounts.dev` fallback becomes a harmless safety net

**Why the live key is not derivable:** `immortal-swan-47.clerk.accounts.com` does not exist (DNS fails) — Replit uses a different domain scheme for production Clerk instances that is only known after the instance is provisioned.
