---
name: Clerk proxy JWT issuer mismatch
description: Mobile Bearer tokens 401 even with correct keys — root cause is the proxyUrl option in clerkMiddleware, NOT the absence of it.
---

# Clerk proxy JWT `iss` — mobile vs web sessions behave differently

## The rule

**Do NOT set `proxyUrl` in `clerkMiddleware()` on the Express server.**

Mobile JWTs always carry `iss: https://<direct-clerk-fapi-host>` (e.g. `https://immortal-swan-47.clerk.accounts.dev`) because the mobile app calls Clerk directly, never through the web proxy.

Setting `proxyUrl` tells the Clerk SDK to expect `iss: <proxyUrl>` — which permanently rejects every mobile token.

Web sessions use **opaque cookie tokens**, not JWTs, so `iss` verification never runs for them regardless of the `proxyUrl` setting.

## Correct `app.ts` configuration

```typescript
// clerkProxyMiddleware() can still proxy browser→Clerk FAPI requests.
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

// clerkMiddleware — NO proxyUrl. Mobile JWTs use the direct Clerk FAPI
// as issuer; web sessions use opaque cookies and skip iss verification.
app.use(clerkMiddleware());
```

## Diagnostic signature

When `proxyUrl` is incorrectly set:
- `requireAuth: 401 — JWT payload` with `jwtIss: "https://immortal-swan-47.clerk.accounts.dev"` — token arrives, but iss doesn't match the proxy URL the SDK expects
- `jwtExpired: false` — token is valid and fresh; pure iss mismatch
- ~65–200ms response time (JWKS roundtrip to Clerk)
- Web app works fine (cookies, no iss check)

When the race condition (no-token) fires instead:
- `requireAuth: 401 — no Bearer token` with `hasAuthHeader: false`
- ~1–5ms response time (rejected immediately, no JWKS call)

**These are two distinct failure modes.** The no-token race (fix: await getToken() before resetQueries) and the iss mismatch (fix: remove proxyUrl) can both be present at the same time.

## Why the confusion occurred

Early sessions saw only the no-token race (hasAuthHeader: false) and assumed an iss mismatch was also present. Adding proxyUrl "fixed" nothing but obscured the real cause. Once the race was fixed and tokens started arriving, the proxyUrl-induced iss mismatch became the new failure.
