---
name: EAS pnpm patch compatibility
description: How to keep patched dependencies reproducible between local installs and EAS remote builds.
---

Pin the workspace pnpm version through the root packageManager field, and define patchedDependencies only in pnpm-workspace.yaml rather than duplicating it under the root package.json pnpm field.

**Why:** Local and EAS-selected pnpm versions interpreted the duplicated patch configuration differently. Local pnpm 11 accepted the lockfile while an unpinned EAS builder rejected the same source with ERR_PNPM_LOCKFILE_CONFIG_MISMATCH.

**How to apply:** When changing pnpm versions or patches, validate with a CI-style frozen install through the pinned package manager before starting an EAS build.