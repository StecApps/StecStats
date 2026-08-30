---
name: Workspace library build order
description: Required build order for local mobile typechecks in the monorepo.
---

The mobile package typecheck depends on generated declarations from workspace libraries; run the root `typecheck:libs` build before checking the Expo app after a fresh clone or branch switch.

**Why:** Running the mobile typecheck first on the Mac produced TS6305 stale-output errors for the shared API client, while the library build followed by mobile typecheck passed.

**How to apply:** From the repository root, run `pnpm run typecheck:libs`, then `pnpm --filter @workspace/hoops-mobile run typecheck` before starting a native release build.