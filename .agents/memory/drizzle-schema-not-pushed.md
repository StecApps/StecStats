---
name: Drizzle schema not pushed in sandbox
description: A restarted/fresh dev database can be missing tables that the schema/code already reference, causing runtime query errors that look like app bugs.
---

Symptom: an API route that queries a table (e.g. `live_sessions`) throws `Error: Failed query: select ... from "table_name" ...` even though the Drizzle schema file for that table exists and is exported correctly, and `tsc`/build succeed.

**Why:** The Drizzle schema in `lib/db/src/schema/*` is just TypeScript — it doesn't create the table. The dev Postgres database needs `drizzle-kit push` run against it separately. If a feature was added in one session and the dev DB was reset/recreated later (or this is a fresh environment), the table can be absent even though the code is correct.

**How to apply:** Before debugging a "table does not exist" / failed-query error as an application bug, run `pnpm run push` in `lib/db` (drizzle-kit push) and retry. Check with `psql "$DATABASE_URL" -c "\d table_name"` first to confirm the table is actually missing.
