---
name: EAS pnpm patch compatibility
description: How to keep patched dependencies reproducible between local installs and EAS remote builds.
---

Pin the workspace to pnpm 10.26.1 through the root packageManager field, and define patchedDependencies only in pnpm-workspace.yaml rather than duplicating it under the root package.json pnpm field.

**Why:** pnpm 11 rewrites the lockfile's patchedDependencies entry as a scalar hash, which it accepts locally, while the EAS builder's pnpm 10 expects the hash-plus-path object format and fails with ERR_PNPM_LOCKFILE_CONFIG_MISMATCH. A duplicated package-level declaration also obscures which configuration is active.

**How to apply:** Regenerate the lockfile with pnpm 10.26.1, confirm each patch lock entry contains both hash and path, then validate with a CI-style frozen install through the pinned package manager before starting an EAS build.