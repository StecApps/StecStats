---
name: Clerk proxy JWT issuer mismatch
description: Why mobile Bearer tokens 401 even when the correct publishableKey and secretKey are set — the proxy permanently changes the JWT iss claim for the whole Clerk instance.
---

# Clerk proxy JWT `iss` mismatch — mobile Bearer tokens always 401

## The rule

When `clerkProxyMiddleware` is active (production), `clerkMiddleware()` on the
Express server **must** be configured with `proxyUrl`. Without it, mobile API
calls always return 401 even though the token is valid and the publishable/secret
keys are correct.

**Why:** The proxy sends `Clerk-Proxy-Url: https://<domain>/api/__clerk` on every
request forwarded to Clerk's FAPI. This permanently configures the Clerk instance
to issue all JWTs — including ones the mobile app fetches **directly** (not through
the proxy) — with `iss: https://<domain>/api/__clerk`. The server middleware without
`proxyUrl` expects `iss: https://<clerk-fapi-host>` → mismatch → 401.

Browser sessions (cookie-based opaque tokens) work fine because they use a different
verification path that doesn't check `iss` in the same way, so the bug is invisible
on the web app.

## How to apply

In `app.ts`:

```typescript
app.use(
  clerkMiddleware(
    process.env.CLERK_PROXY_URL ? { proxyUrl: process.env.CLERK_PROXY_URL } : {},
  ),
);
```

Set `CLERK_PROXY_URL=https://<domain>/api/__clerk` as a **production-only** env var
(not shared/dev — the proxy is a no-op in dev, so `iss` matches the direct FAPI
host there). For stecstats.com: `CLERK_PROXY_URL=https://stecstats.com/api/__clerk`.

## Diagnostic signature

- `hasAuthHeader: true`, `authType: Bearer`, `tokenLength: ~785` in requireAuth debug
- No Clerk SDK error logged — failure is silent
- First 401 response time ~250 ms (JWKS fetch), subsequent ones ~35 ms (cached JWKS)
- Browser sessions work fine; only mobile Bearer tokens fail
