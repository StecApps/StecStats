---
name: pnpm unusable after production build cleanup
description: Production build removes pnpm package cache — artifact run commands must use node directly, not pnpm --filter.
---

# pnpm unusable after production build cleanup

The production build phase ends with a cleanup step that removes ~97 000 files including pnpm's package/workspace metadata. After cleanup, `pnpm --filter @workspace/<pkg> run <script>` silently fails to open its port (process starts, never binds).

**Why:** pnpm needs the workspace node_modules hoisting structure to resolve packages. The cleanup step strips that, so pnpm can't locate the script entry point.

**How to apply:** Any artifact whose `[services.production.run]` uses `pnpm --filter ... run <script>` will break. Replace with a direct `node <path/to/script.js>` invocation and set all required env vars in `[services.production.run.env]`. The api-server already does this correctly (`node artifacts/api-server/dist/index.mjs`). Applied the same pattern to hoops-mobile (`node artifacts/hoops-mobile/server/serve.js`).

**Symptoms:** "not all artifact ports opened within timeout" / "ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL … signal: terminated" in deployment logs. The process starts (pid shows up) but never opens its port.
