---
name: Token refresh race — getToken() null during active refresh
description: resetQueries() on isSignedIn fires before getToken() resolves, sending re-fetches with no Authorization header even when the user is signed in.
---

## The Rule
Always `await getToken()` and confirm it's non-null before calling `qc.resetQueries()`. Do NOT call `resetQueries()` synchronously on `isSignedIn === true`.

## Why
Clerk's `getToken()` returns null while a token refresh is in-flight (~600ms round-trip). If `isSignedIn` becomes true during or just before the refresh, a synchronous `resetQueries()` triggers re-fetches that also get null from `getToken()` → no Authorization header → 401 errors cached again. This creates an apparent infinite loop of 401s even though the session is valid.

Production evidence: deployment logs showed `requireAuth: 401 — no Bearer token, hasAuthHeader: false` in rapid bursts (~8 requests in 10 seconds) while a Clerk session token endpoint returned 200 at 595ms latency in the same window.

## How to Apply
In `ApiAuthSetup` in `artifacts/hoops-mobile/app/_layout.tsx`:

```typescript
useEffect(() => {
  if (!isSignedIn) return;
  let cancelled = false;
  getToken().then((token) => {
    if (!cancelled && token) {
      qc.resetQueries();
    }
  });
  return () => { cancelled = true; };
}, [isSignedIn, qc, getToken]);
```

The cleanup flag prevents calling `resetQueries()` after unmount (e.g. if sign-out races the async token fetch).
