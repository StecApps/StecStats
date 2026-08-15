---
name: Replit Clerk live vs test instance — mobile auth
description: Mobile tokens use immortal-swan-47 (test instance); live Clerk middleware rejects them. Fallback verifyToken in requireAuth is REQUIRED — do not remove it until the mobile app is rebuilt with a live-instance key.
---

## The Problem

**Replit auto-swaps `CLERK_PUBLISHABLE_KEY` to a live Clerk instance key on publish.** The server's `clerkMiddleware()` uses the live JWKS and expects `iss: <live-instance>`. The EAS production binary was built with the test key (`pk_test_...`, `immortal-swan-47.clerk.accounts.dev`) baked in — mobile tokens carry `iss: https://immortal-swan-47.clerk.accounts.dev` → rejected by live-instance JWKS.

## The Fallback (MUST stay in requireAuth.ts)

`requireAuth.ts` has a fallback using `verifyToken(token, { publishableKey: EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY })`. When `clerkMiddleware()` rejects a Bearer token, this verifies it directly against the mobile/test Clerk instance.

**Do NOT remove this fallback** until the mobile app is rebuilt with a live-instance publishable key. Task agents have removed it twice already — each time broke all mobile authentication on the next production deploy.

**Why it keeps getting removed:** task agents see "dual Clerk instance workaround" and treat it as cleanup. It is NOT safe to remove until step 4 of the permanent fix below is complete.

## Diagnostic signature

- All mobile API calls return 401 at ~200–450ms (Clerk fetches JWKS, validates, fails)
- Web sessions work fine (cookies, no iss check)
- Production logs show no `requireAuth: mobile token verified` lines → fallback is missing or `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` is unset

## Permanent fix (requires a new app build)

1. **Publish via Replit** (already done) — auto-provisions the Clerk Production instance
2. Open `dashboard.clerk.com` → switch to **Production** instance → **API Keys** → copy the `pk_live_...` publishable key
3. Replace `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` in `artifacts/hoops-mobile/eas.json` production env block
4. Run `eas build --platform ios --profile production` and confirm sign-in works on device
5. Only after confirming step 4: remove the fallback block from `requireAuth.ts`

**Why the live key is not derivable from env:** the live Clerk instance domain differs from `immortal-swan-47.clerk.accounts.dev` and is only known after Clerk provisions it on first publish.
