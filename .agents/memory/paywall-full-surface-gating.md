---
name: Paywall gating must cover every response field/section
description: When implementing a Free/Pro paywall spec, enumerate every distinct spec line item (limits, scope restrictions, computed/derived fields) and verify each is enforced server-side — not just the obvious create/count limits.
---

A paywall spec like "Free: 1 player, current season only, basic stats" contains multiple independent restrictions:
1. A count limit (1 player) — easy to spot, usually implemented first.
2. A data-scope restriction ("current season only") — easy to miss because there may be no explicit `season` column; it has to be derived (e.g. from a date range) and applied to every read query that returns season/career data, not just the primary one.
3. Feature-gated *fields* within an otherwise-shared response (e.g. shooting-efficiency percentages) — these must be omitted or nulled server-side for Free, with the response schema changed to make them optional. Sending the real numbers and only hiding them in the UI is not enforcement.

**Why:** A code review caught that career dashboard + shooting-efficiency gauges were marked Pro-only in the spec but the `/players/:id/summary` endpoint returned full unrestricted data to Free users, and "current season only" was never implemented at all (no season concept existed in the schema).

**How to apply:** Before declaring paywall/entitlement work done, re-read the original spec line by line and map each clause to a specific server-side check. For scope restrictions without a schema column, derive them from existing data (e.g. a season-start-date helper) rather than adding a migration. For gated fields, make them optional in the API schema and add a `plan`/`scope` field to the response so the frontend can render honest upsell UI instead of guessing.
