---
name: Expo prebuild dependency rewrite
description: Why Expo core must remain a runtime dependency for deterministic native release preparation.
---

Keep the Expo core package under runtime dependencies, not development-only dependencies, for mobile artifacts that run Expo prebuild during release preparation.

**Why:** Expo prebuild rewrites the package manifest to move/add Expo under runtime dependencies even when `--no-install` is used. That creates an unexpected dirty tree and can desynchronize the lockfile during a release.

**How to apply:** Before relying on a clean prebuild, make sure Expo core is declared in runtime dependencies and the lockfile importer matches. Use `--no-install` to separate CocoaPods/package installation from native generation so any install delay is visible.