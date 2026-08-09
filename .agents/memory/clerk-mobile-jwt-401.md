---
name: Clerk mobile JWT 401 — publishableKeyFromHost pitfall
description: Why mobile Bearer-token auth 401s while browser cookie sessions work fine on the same server.
---

The `clerkMiddleware` was configured with a dynamic callback using `publishableKeyFromHost` from `@clerk/shared/keys`:

```typescript
app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "",
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })),
);
```

**Why this breaks mobile:** `publishableKeyFromHost` is designed for Clerk custom-domain setups where the hostname itself encodes the publishable key (e.g. `clerk.yourdomain.com`). For a plain production hostname like `stecstats.com`, it can return `undefined`, leaving the middleware without a publishable key. Without the key the server cannot fetch JWKS and cannot verify short-lived JWTs sent by the mobile app via `Authorization: Bearer`. Cookie-based browser sessions use a different verification path (opaque session token + secret key only) so they continue working.

**Symptom:** Production logs show `/api/__clerk/v1/client/sessions/.../tokens` → 200 (tokens fetched fine) but every API route → 401.

**Fix:** Use `clerkMiddleware()` with no arguments and rely on `CLERK_SECRET_KEY` + `CLERK_PUBLISHABLE_KEY` env vars directly:

```typescript
app.use(clerkMiddleware());
```

Remove the `publishableKeyFromHost` import entirely. This is the correct pattern for single-domain deployments.

**Why:** The Clerk SDK reads `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` from env automatically when no options are passed. No dynamic resolution needed unless you're running a true multi-tenant custom-domain setup.
