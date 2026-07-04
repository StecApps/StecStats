---
name: Frontend API routing convention
description: How hoops-stats (and similar pnpm-monorepo web artifacts) route API calls to the backend api-server.
---

Frontend code calls `/api/...` as a root-relative path directly in `fetch()` calls and in orval's generated client (`baseUrl: "/api"` in `lib/api-spec/orval.config.ts`). It is NOT prefixed by the artifact's `BASE_URL`/preview path, even though other static asset URLs in the same app are.

**Why:** The gateway/proxy routes `/api/*` requests to the `api-server` artifact regardless of which artifact's preview path the browser is currently on. The `api-server` Express app mounts all routes under `/api`.

**How to apply:** When adding any new fetch call, upload URL, media src, or similar to a page in a web artifact that talks to `api-server`, use a literal `/api/...` path (e.g. `/api/storage/objects/...`), not `${BASE_URL}api/...`. This matches the existing convention used by all other generated API client calls in the app.
