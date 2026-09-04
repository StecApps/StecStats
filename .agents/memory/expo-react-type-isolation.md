---
name: Expo React type isolation
description: Why the Expo mobile package must resolve SDK-compatible React type versions independently from sibling web packages.
---

Do not use workspace-wide pnpm overrides for `@types/react` or `@types/react-dom` when the web and Expo artifacts require different compatible versions. Allow the mobile importer to retain the versions expected by its Expo SDK, while web packages can continue using their catalog versions.

**Why:** A global override silently forced the mobile dependency graph onto React 19.2 types even though the Expo SDK expected 19.1 types. This desynchronized the mobile manifest and lockfile, causing Expo Launch to fail at `pnpm install --frozen-lockfile` before native compilation.

**How to apply:** When changing React types, run the exact root frozen install used by CI and run `expo install --check` from the mobile package. Inspect the mobile importer in `pnpm-lock.yaml`; do not assume the package manifest alone determines the resolved type version.