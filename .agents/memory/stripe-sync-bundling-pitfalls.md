---
name: stripe-replit-sync bundling & backfill pitfalls
description: Two silent-failure modes — esbuild bundling loses the library's migrations dir, and no-arg syncBackfill() syncs nothing.
---

# stripe-replit-sync silent-failure pitfalls

**Rule 1:** when the api-server is esbuild-bundled to a single file, stripe-replit-sync's `runMigrations()` resolves its `.sql` files via `__dirname/migrations` — which becomes `dist/` after bundling. The library then logs "Migrations directory not found" and *silently skips all migrations*, leaving the `stripe` schema with zero tables (payments completely dead). The build script must copy the package's `migrations/` dir into `dist/migrations`, and boot must verify `to_regclass('stripe.accounts')` exists afterward — exiting the process (not throwing, since the init error is swallowed to a log line) if missing.

**Rule 2:** `syncBackfill()` called with NO params is a no-op — the library defaults `object` to a function reference that falls through its switch statement and syncs nothing. Use `syncBackfill({ object: "all" })`. Gate it on the tables being empty (e.g. `SELECT 1 FROM stripe.products LIMIT 1`) because "all" syncs every historical Stripe object and blocks listen — unbounded boot latency on autoscale instance cycles. Webhooks maintain steady state after the one-time seed.

**Why:** production ran for weeks with the stripe schema empty and every boot logging a single swallowed error; subscriptions were entirely broken with no visible failure.

**How to apply:** any bundled deployment using stripe-replit-sync needs (1) migrations copied into dist, (2) a fatal post-migration table check, (3) `{ object: "all" }` with an emptiness gate. Also note: `findOrCreateManagedWebhook` deletes managed webhooks not present in the caller's own DB — dev and prod sharing one Stripe account can delete each other's webhooks; keep prod on separate live-mode credentials.
