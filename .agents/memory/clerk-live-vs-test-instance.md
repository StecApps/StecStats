---
name: Replit Clerk live vs test instance — mobile auth
description: Live Clerk key is in eas.json but clerk.stecstats.stecco.org has no DNS — proxy is required. A fallback exists for the old binary. Remove it after the new build is confirmed.
---

## The root cause

Replit auto-swaps `CLERK_PUBLISHABLE_KEY` to a live instance key on publish. The old EAS production binary was compiled with the Replit-managed **test** key (`immortal-swan-47.clerk.accounts.dev`) baked in, so mobile tokens carried `iss: https://immortal-swan-47.clerk.accounts.dev` → rejected by the live-instance JWKS used by `clerkMiddleware()`.

## Current state

`eas.json` production env carries `pk_live_Y2xlcmsuc3RlY3N0YXRzLnN0ZWNjby5vcmck`.

**Critical:** `clerk.stecstats.stecco.org` (the live FAPI custom domain decoded from that key) has **no DNS record** — `curl` returns 000. The Clerk SDK with the live key cannot reach its API directly, causing every `signIn.create()` call to fail with "undefined is not a function."

**Fix:** `eas.json` now sets `EXPO_PUBLIC_CLERK_PROXY_URL=https://stecstats.com/api/__clerk`. `_layout.tsx` reads that env var and passes it as `proxyUrl` to `ClerkProvider`. The proxy at `/api/__clerk` forwards to `frontend-api.clerk.dev`, bypassing the broken custom domain entirely.

The next TestFlight build (after `git pull` + `eas build --profile production --local`) will use this proxy and send live-instance tokens that `clerkMiddleware()` accepts directly.

## The fallback (still in requireAuth.ts)

A JWKS fallback block keeps the **old** TestFlight binary working during the transition. It is pinned to exactly `https://immortal-swan-47.clerk.accounts.dev` — no wildcard, to prevent other Clerk dev instances from forging access.

**Do NOT remove until** a new TestFlight binary (built with the live key + proxy) is confirmed working on device. The block is labelled "REMOVE THIS BLOCK once..." in the source.

**Why it kept getting removed:** agents treated it as cleanup. It is not safe to remove until coaches are running the new binary.

## Cleanup criterion

Remove the `if (!clerkUserId)` fallback block from `requireAuth.ts` once sign-in from a device running the new proxy build is confirmed (log shows `clerkMiddleware` accepting the token, no JWKS fallback lines).
