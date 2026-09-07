---
name: Autoscaled background-job leases
description: Ownership and publication rules for long-running work across multiple server instances.
---

Long-running media jobs in an autoscaled service must atomically claim a database-owned lease and unique run token. Heartbeats renew with database time, and every ready/failed/object-path write must compare the current token and active status.

**Why:** Process-local in-flight maps disappear on restart and are invisible to sibling instances. Without database fencing, duplicate workers can overlap and an older run can overwrite a newer result.

**How to apply:** Treat in-memory state only as a local optimization. Clear the token on every terminal or cancellation transition, abort token-scoped work when ownership is lost, make stale cleanup conditional, and periodically sweep expired leases so replacement instances recover jobs missed at boot.