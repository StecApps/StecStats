---
name: Destructive Clerk routes
description: Safely identify the authenticated Clerk subject for irreversible API actions.
---

For destructive routes, compare the Clerk subject that `requireAuth` actually
verified against the local account's stored Clerk identity before deleting data.
Carry that subject on the request; do not call `getAuth()` again in the route.

**Why:** Same-email accounts from different Clerk instances are intentionally
mapped to one local profile, while legacy mobile sessions can be verified by
the middleware's pinned-JWKS fallback even though `getAuth()` has no user ID.
Re-reading Clerk state in a destructive route can either reject a valid legacy
session or target the mapped primary identity rather than the caller.

**How to apply:** Have authentication middleware attach the verified subject to
the request before any convenience account mapping. Destructive handlers must
use that attached subject and reject a mismatch before storage or database work.