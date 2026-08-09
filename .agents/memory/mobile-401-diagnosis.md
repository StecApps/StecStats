---
name: Mobile 401 diagnosis — two patterns
description: Definitive root-cause analysis of iOS TestFlight app returning 401 on every API call despite being signed in via Clerk.
---

## Two distinct 401 patterns (response time is the tell)

### Pattern 1 — 1–3ms: No Bearer token
`getToken()` returns null. React Query fires requests during Clerk's loading window before the session is ready. No `Authorization` header → server rejects instantly with no JWKS fetch.

**Root cause**: Old code used `queryClient.invalidateQueries()` on sign-in, which skips *error-cached* entries. The pre-auth 401 errors survived sign-in and permanently blocked re-fetches.

**Fix** (already merged): `queryClient.clear()` on `isSignedIn → true` wipes everything including error entries, forcing a clean re-fetch with the fresh token. Also: `setAuthTokenGetter(() => getToken())` with no `isSignedIn` closure so the getter always asks Clerk for the current token.

### Pattern 2 — 70ms: Bearer token sent but rejected
Token IS sent; 70ms matches a JWKS fetch from `api.clerk.com` (cache TTL = 5 minutes). Traced the Clerk backend path:
- `authenticateRequestWithTokenInHeader` → `verifyToken` → `TokenExpired`
- `handleSessionTokenError` → `handleMaybeHandshakeStatus`
- `isRequestEligibleForHandshake()` returns `false` for API/JSON requests (only true for GET+`Sec-Fetch-Dest: document/iframe` or `Accept: text/html`)
- Falls through to `signedOut` → 401

**Root cause**: Clerk dev-instance JWTs live 60 seconds. Expo SDK reads a stale cached JWT from SecureStore on cold start before the background refresh completes. After the null-token fix, `getToken()` is only called after Clerk is ready with a fresh token, so this should self-resolve.

**Why `verifyJwt` doesn't check `iss`**: Confirmed in source — only `sub`, `aud`, `azp`, `exp`, `nbf`, `iat` are checked. The `proxyUrl` setting in `clerkMiddleware` does NOT affect Bearer token verification path.

**BAPI cannot list dev-instance sessions**: `GET /v1/sessions?user_id=...` returns `[]`; `GET /v1/sessions/{id}` returns 404 for dev-instance session IDs. JWKS IS accessible via BAPI and returns the correct key.

## Key constants
- `MAX_CACHE_LAST_UPDATED_AT_SECONDS = 5 * 60` (JWKS cache TTL)
- `DEFAULT_CLOCK_SKEW_IN_MS = 5000` (5 seconds)

## Debug logging added to requireAuth.ts
Logs `jwtIss`, `jwtAzp`, `jwtExp`, `secondsToExpiry`, `clerkError`, `clerkReason` on every 401. Gets the exact Clerk SDK error reason from `clerkClient.verifyToken(token)`. Only in workspace (not yet published to prod).

## If 70ms 401s persist after new build
Publish the workspace → deployment logs will show `clerkReason`. If `TokenExpired`, consider `clockSkewInMs` increase in `clerkMiddleware` or `getToken({ skipCache: true })` in mobile.

**Why:** The fix for the null-token issue should eliminate most expired-token cases too, since queries only fire after Clerk is ready. If not, the debug log gives the exact error.
