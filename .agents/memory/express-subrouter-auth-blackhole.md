---
name: Express sub-router auth blackhole
description: router.use(requireAuth) with no path prefix on a sub-router silently blocks unrelated routes mounted after it, not just its own routes.
---

When multiple Express sub-routers are all mounted at root with `app.use(subRouterA)`, `app.use(subRouterB)`, ... (no path prefix), a bare `router.use(requireAuth)` inside `subRouterA` runs for **every** request that reaches `subRouterA`, regardless of whether that request's path matches any route `subRouterA` actually defines. If `requireAuth` sends a 401 without calling `next()`, it swallows the request entirely — `subRouterB` (mounted later, e.g. containing intentionally-public routes) never gets a chance to handle it.

**Why:** Express treats a path-less `router.use(fn)` as matching path `"/"`, i.e. everything the router receives, not just the router's own declared route patterns. Sibling sub-routers mounted at root all receive the same request stream in registration order.

**How to apply:** When some routes in a codebase must stay public (e.g. account-free live-stream viewer endpoints) while sibling routers require auth, apply the auth middleware **per-route** (`router.get("/path", requireAuth, handler)`), not via a router-wide `.use()` — unless that sub-router is mounted with its own unique path prefix that no other router shares.
