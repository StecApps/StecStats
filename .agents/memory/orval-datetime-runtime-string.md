---
name: Orval date-time fields typed Date but arrive as string
description: Generated api-client-react types say `Date` for OpenAPI date-time fields, but the runtime value from customFetch is a raw ISO string.
---

Orval's TS-client generator maps OpenAPI `type: string, format: date-time`
fields to a `Date` type in the generated types, but the generated
`customFetch` wrapper never zod-parses or coerces the JSON response — it just
`JSON.parse`s the raw body. So at runtime, any "Date-typed" field from a
generated hook is actually still a plain ISO string.

**Why:** the type generator and the runtime fetch wrapper aren't coupled;
the type is aspirational, not enforced, so consuming code that expects a
real `Date` (e.g. calling `.getTime()` directly) will throw at runtime
even though it compiles.

**How to apply:** when consuming any generated date-time field client-side,
wrap it in `new Date(value)` before use, and guard for `null`/`undefined`.
Don't trust the generated type to mean the value is already a `Date`
instance.
