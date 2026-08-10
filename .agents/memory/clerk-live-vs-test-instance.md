---
name: Replit Clerk live vs test instance split — mobile auth
description: Replit auto-swaps CLERK_PUBLISHABLE_KEY to a live Clerk instance on publish; EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY stays as the test key. Mobile tokens are always from the test instance and are rejected by the live-instance clerkMiddleware.
---

## The Rule

**EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY is NOT auto-swapped on publish.** It stays as the test Clerk key (`pk_test_...`, `immortal-swan-47.clerk.accounts.dev`) even in production.

Replit auto-swaps `CLERK_PUBLISHABLE_KEY` and `VITE_CLERK_PUBLISHABLE_KEY` to live keys when publishing. The server's `clerkMiddleware()` therefore uses the live Clerk JWKS and expects `iss: <live-instance>`. Mobile tokens always carry `iss: immortal-swan-47.clerk.accounts.dev` → rejected.

## The Fix (no new app build required)

In `requireAuth.ts`, add a fallback `verifyToken` call using `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` when the primary middleware rejects a Bearer token:

```typescript
if (!clerkUserId && token && process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY) {
  try {
    const payload = await verifyToken(token, {
      publishableKey: process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY
    });
    clerkUserId = payload.sub ?? null;
  } catch (err) {
    // log the verifyErr for debugging
  }
}
```

`verifyToken` from `@clerk/express` fetches JWKS from the FAPI URL derived from the publishable key — no secret key needed for public JWT verification.

## Why

Replit provisions separate Clerk tenants for dev and prod. The mobile app has its key baked in at build time and can't be auto-swapped. The only way to permanently fix this without a server-side fallback is to rebuild the mobile app with the live publishable key — but that requires knowing the live key value (not auto-surfaced by Replit) and uploading a new TestFlight build.

## Diagnostic signature

- `requireAuth: 401 — JWT payload` with `jwtIss: "https://immortal-swan-47.clerk.accounts.dev"` in PRODUCTION logs
- All three publishable keys decode to the same test instance in the dev environment
- Web sessions work fine (cookies bypass JWKS verification)
- Only Bearer token (mobile) requests fail
