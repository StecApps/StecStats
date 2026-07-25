---
name: openapi.yaml is the only codegen source of truth
description: Running codegen silently deletes any fields that were hand-added to generated client files; parallel-task merges are the usual culprit.
---

## The rule

Never rely on fields that exist only in `lib/api-zod/src/generated/*` or `lib/api-client-react/src/generated/*`. Any field not declared in `lib/api-spec/openapi.yaml` is deleted the next time `pnpm --filter @workspace/api-spec run codegen` runs.

**Why:** A parallel task added soccer fields (Team.sport, PlayerGameStatLine goals/shots/saves/cards, BillingStatus.hasSoccer, checkout tier "soccer") directly to the generated files without touching the spec. A later codegen run for an unrelated feature stripped them all, breaking type-checks across billing, teams, and the frontend. They had to be reconstructed from git diffs of the generated files.

**How to apply:**
- Before running codegen, `git diff` the generated directories; if there are uncommitted hand-edits, port them into `openapi.yaml` first.
- After a task merge touching the API surface, verify `openapi.yaml` mentions the new fields (`grep`), not just the generated output.
- To reconstruct lost fields, read the removed lines from `git diff` of the generated zod file — it encodes optionality, defaults, and min constraints (`.optional().default(0)`, `.min(0)`).
