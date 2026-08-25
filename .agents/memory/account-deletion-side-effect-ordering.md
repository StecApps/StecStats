---
name: Account deletion side-effect ordering
description: Ordering irreversible external cleanup around local account deletion.
---

For direct account deletion, finish the local database transaction before
removing the sign-in identity. Defer revoking external integrations until after
the local transaction; if such a best-effort revoke fails after data deletion,
log it without stranding the deletion flow.

**Why:** An external identity or OAuth authorization cannot be restored by a
database rollback. Deleting either before a retryable storage or database
failure leaves a retained account inaccessible or partially disconnected.

**How to apply:** Keep pre-transaction cleanup limited to operations whose
failure leaves the account intact. On a post-local-cleanup identity-provider
failure, return explicit re-sign-in/retry guidance and ensure authentication
can create only an empty profile for that retry.