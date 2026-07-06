---
name: Multi-tenant ownerId scoping patterns
description: How per-account data isolation was implemented and hardened across a Drizzle/Express API; read before adding any new table, join, or object-storage link in a multi-tenant app.
---

## Pattern
Every table holding user data gets a nullable `ownerId` column. Reads/writes filter by `eq(table.ownerId, req.appUser!.id)`. Not-found/not-owned always returns 404, never 403 — this avoids confirming the existence of another tenant's record.

**Why:** legacy pre-multi-tenant rows exist with `ownerId = NULL`; nullable + app-level enforcement lets those rows be "claimed" by whichever account signs in first, without a destructive migration.

## Claim-on-first-login
On JIT user provisioning (first login), wrap the "claim all NULL-owner rows" UPDATEs in a single `db.transaction(...)`, not `Promise.all(...)`. Partial claims (some tables updated, others not) are a valid failure mode if updates run independently and one throws mid-flight.

## FK-from-request-body is a distinct vulnerability class
Any endpoint accepting a body that references another table's row by ID (e.g. `stats[].playerId` inside a game payload) must explicitly validate that every referenced ID belongs to the requesting owner — a per-table ownerId filter on the *parent* resource is not sufficient, because the child IDs travel in the body and can be scoped to any tenant. Write a small `assertXOwned(ids, ownerId)` helper (dedupe, `inArray` + `eq(ownerId)`, compare counts) and call it before any insert/update transaction that accepts foreign IDs.

## Unscoped joins leak even after the write path is fixed
Closing the injection at write-time is not enough: any `serialize`/`select`-with-join helper that resolves display data (team name, player name) via a raw join on a FK column, without also filtering the joined table by `ownerId`, can still leak foreign tenant data if any inconsistent/legacy row ever exists. Every join used for cross-table display data needs the owner filter *in the join condition itself* (or an equivalent WHERE), not just on the top-level/parent row.

## Object storage links are a second FK-from-body vector
If a mutable body field (e.g. `videoObjectPath`) lets a client link their DB row to an arbitrary object-storage path, and the storage read endpoint trusts "the DB row that references this path belongs to you" as authorization, an attacker can "claim" another tenant's already-uploaded object by referencing its path in their own row — this also lets them silently overwrite that object's ACL-policy ownership if ACL writes are unconditional.

Fix requires **both**:
1. Before mutating ACL, check the object's existing ACL policy; if it has a different owner, reject (409).
2. Also check DB linkage across sibling columns (e.g. both `videoObjectPath` and `highlightObjectPath`) for any *other* owner already referencing that exact path — ACL-missing legacy objects still need this check, since they'd otherwise have no policy to block the claim.

Treat ACL-write failures as request failures (abort), never log-and-swallow — a swallowed failure can leave a DB row linked to an object whose real ACL ownership doesn't match, silently reopening the storage authorization gap.
