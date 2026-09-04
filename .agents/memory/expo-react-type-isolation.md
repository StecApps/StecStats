---
name: Expo React type isolation
description: Why the Expo mobile package must resolve SDK-compatible React type versions independently from sibling web packages.
---

Do not put `@types/react` or `@types/react-dom` in workspace-wide pnpm overrides or the default catalog when web and Expo require different compatible versions. Declare the web and mobile type versions directly in their package manifests.

**Why:** A global override silently forced the mobile dependency graph onto React 19.2 types even though the Expo SDK expected 19.1 types. This desynchronized the mobile manifest and lockfile, causing Expo Launch to fail at `pnpm install --frozen-lockfile` before native compilation.

**How to apply:** When changing React types, update each artifact's explicit declaration, regenerate the lockfile, run the exact root frozen install used by CI, and run `expo install --check` from the mobile package. Inspect the mobile importer in `pnpm-lock.yaml`; do not assume one shared version fits both artifacts.