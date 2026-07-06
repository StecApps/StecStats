---
name: "@workspace/db composite declarations"
description: Why a schema change can leave consumers typechecking against stale DB types
---

# @workspace/db emits declarations; consumers read the emitted .d.ts

`lib/db/tsconfig.json` is `composite: true` + `emitDeclarationOnly` with `outDir: dist`. Its `package.json` exports point at `src`, but TypeScript project references (api-server references `../../lib/db`) resolve types through the **emitted `lib/db/dist/*.d.ts`**, not the source.

**Symptom:** after adding a column to `lib/db/src/schema/*.ts` and pushing to the DB, api-server still errors "Property X does not exist" / "Object literal may only specify known properties."

**Fix:** rebuild the declarations with build mode + force: `npx tsc -b lib/db/tsconfig.json --force`. Plain `tsc -p ... --force` is a no-op flag combo and won't re-emit; deleting `.tsbuildinfo` alone doesn't remove the stale `dist/*.d.ts`.
