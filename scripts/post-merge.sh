#!/bin/bash
set -e
pnpm install --no-frozen-lockfile
# Database additions used by the API are applied idempotently at boot. Avoid a
# broad drizzle push here: it may propose deleting legacy production columns
# that are intentionally retained outside the current Drizzle schema.
pnpm -w run typecheck:libs
