/**
 * One-time script: delete stale stripe._managed_webhooks rows pointing at
 * dev/workspace URLs. Run against whichever DATABASE_URL is in scope.
 *
 *   pnpm --filter @workspace/api-server exec tsx scripts/cleanup-stale-webhooks.ts
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  // Show current state first
  const before = await db.execute(
    sql`SELECT id, url, livemode, status FROM stripe._managed_webhooks ORDER BY created`,
  );
  console.log("Current rows:", before.rows);

  // Delete stale rows pointing at dev URLs
  const result = await db.execute(
    sql`DELETE FROM stripe._managed_webhooks
        WHERE url LIKE '%replit.app%'
           OR url LIKE '%.riker.replit.dev%'
           OR url LIKE '%.replit.dev%'
        RETURNING id, url, livemode`,
  );

  if (result.rows.length === 0) {
    console.log("No stale rows found — nothing to delete.");
  } else {
    console.log(`Deleted ${result.rows.length} stale row(s):`);
    for (const row of result.rows) {
      console.log(`  ${row.id}  livemode=${row.livemode}  url=${row.url}`);
    }
  }

  // Show final state
  const after = await db.execute(
    sql`SELECT id, url, livemode, status FROM stripe._managed_webhooks ORDER BY created`,
  );
  console.log("Remaining rows:", after.rows);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
