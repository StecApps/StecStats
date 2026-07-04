---
name: Orval params naming collision
description: TS2308 collision when an OpenAPI operation mixes path params and query params under Orval's zod + TS client generators.
---

When an operation has both a path param and a query param, Orval's zod
generator bundles all params (path+query) into one `<OperationId>Params`
zod object, while the TS client/types generator emits a *separate*
`<OperationId>Params` type for the query-only params. Both land in
generated output with the same name, causing a TS2308 redeclaration error.

**Why:** the zod and TS-client generators use different, inconsistent
naming conventions for the "same" operation's parameters, and this only
surfaces when an operation mixes path + query params together.

**How to apply:** avoid combining a path param with a query param on the
same OpenAPI operation. Prefer filtering client-side after fetching the
path-scoped resource, or split into distinct endpoints/path segments
instead of a query string, to sidestep the collision entirely.
