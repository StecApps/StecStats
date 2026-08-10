---
name: Clerk proxy JWT issuer mismatch
description: Mobile Bearer tokens 401 even with correct keys — root cause is CLERK_PROXY_URL env var being auto-read by the Clerk SDK, silently changing the expected JWT iss.
---

# Clerk proxy JWT `iss` — the CLERK_PROXY_URL env var trap

## The rule

**Never set `CLERK_PROXY_URL` as an environment variable on the server unless you explicitly want the Clerk SDK to use it as the proxy URL.**

The Clerk SDK (`@clerk/backend`, `@clerk/express`) automatically reads `CLERK_PROXY_URL` from `process.env` at startup. When it finds it, it configures the SDK to expect JWT `iss` = the proxy URL — even if you do NOT pass `proxyUrl` to `clerkMiddleware()` in code. Removing `proxyUrl` from code is NOT enough if the env var is still set.

## Correct server configuration (no mobile JWT issues)

In `app.ts`:
```typescript
// NO proxyUrl option — mobile JWTs use the direct Clerk FAPI as iss.
// Web sessions use opaque cookies and skip iss verification entirely.
app.use(clerkMiddleware());
```

In production environment variables: **do NOT set `CLERK_PROXY_URL`**.

`clerkProxyMiddleware()` can still be mounted to proxy browser→Clerk FAPI requests — that is independent of how clerkMiddleware verifies incoming tokens.

## Why mobile and web sessions are different

- **Web sessions**: use opaque cookies (`__session` cookie), verified server-side via Clerk API — `iss` check does not run.
- **Mobile sessions**: use Bearer JWTs with `iss: https://<direct-clerk-fapi>` (e.g. `immortal-swan-47.clerk.accounts.dev`) — `iss` check DOES run.

Setting `CLERK_PROXY_URL` (or `proxyUrl`) makes the server expect `iss: <proxyUrl>`, which permanently breaks all mobile Bearer token verification.

## Diagnostic signature

When `CLERK_PROXY_URL` is set (or `proxyUrl` is in code):
- `requireAuth: 401 — JWT payload` with `jwtIss: "https://immortal-swan-47.clerk.accounts.dev"` — token arrives and is valid, but iss doesn't match the proxy URL the SDK expects
- `jwtExpired: false`, ~65–200ms response time (JWKS roundtrip)
- Web app works fine (cookies, no iss check)

When the mobile race condition fires (no-token race):
- `requireAuth: 401 — no Bearer token` with `hasAuthHeader: false`
- ~1–5ms response time (rejected immediately, no Clerk call)

**These are two distinct failure modes** that can coexist; fix both independently.

## How we got here (for future context)

Session saw `hasAuthHeader: false` 401s → assumed iss mismatch → set `CLERK_PROXY_URL` + `proxyUrl` in code → race condition was fixed (tokens now sent) → but `CLERK_PROXY_URL` caused the iss mismatch we were trying to prevent → had to delete the env var and remove `proxyUrl` from code.
