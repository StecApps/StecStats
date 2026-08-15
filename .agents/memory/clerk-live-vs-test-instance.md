---
name: Replit Clerk live vs test instance — mobile auth
description: Live Clerk key is now in eas.json. A narrowly-scoped fallback remains for the old TestFlight build (immortal-swan-47 only). Remove it after the new build is confirmed.
---

## The root cause

Replit auto-swaps `CLERK_PUBLISHABLE_KEY` to a live instance key on publish. The old EAS production binary was compiled with the Replit-managed **test** key (`immortal-swan-47.clerk.accounts.dev`) baked in, so mobile tokens carried `iss: https://immortal-swan-47.clerk.accounts.dev` → rejected by the live-instance JWKS used by `clerkMiddleware()`.

## Current state

`eas.json` production env now carries `pk_live_Y2xlcmsuc3RlY3N0YXRzLnN0ZWNjby5vcmck`. The next TestFlight build will send live-instance tokens that `clerkMiddleware()` accepts directly.

## The fallback (still in requireAuth.ts)

A JWKS fallback block keeps the **old** TestFlight binary working during the transition. It is pinned to exactly `https://immortal-swan-47.clerk.accounts.dev` — no wildcard, to prevent other Clerk dev instances from forging access.

**Do NOT remove until** a new TestFlight binary (built with the live key) is confirmed working on device. The block is labelled "REMOVE THIS BLOCK once..." in the source.

**Why it kept getting removed:** agents treated it as cleanup. It is not safe to remove until coaches are running the new binary.

## Cleanup criterion

Remove the `if (!clerkUserId)` fallback block from `requireAuth.ts` once sign-in from a device running the new build is confirmed (log shows `clerkMiddleware set userId`, no JWKS fallback lines).
