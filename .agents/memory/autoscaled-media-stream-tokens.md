---
name: Autoscaled media stream tokens
description: Why mobile media authorization must survive routing across API instances.
---

Media stream and HLS tokens must be stateless, integrity-protected, and valid on every autoscaled API instance. An in-memory map may cache entitlement re-check state, but it cannot be the source of truth.

**Why:** Production routed the authenticated token-mint request to one process and AVPlayer's immediate range or HLS request to another. Process-local UUID tokens then returned 401, producing black highlight/lowlight players and Film Room videos that never loaded.

**How to apply:** Sign the bound media claims with the server session secret, validate expiry plus game/type binding on every instance, and reconstruct a local cache entry after signature verification. Preserve periodic entitlement re-checks and fail closed.