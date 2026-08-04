/**
 * One-time backfill: write ACL policy metadata (owner + visibility=private)
 * onto every game video / highlight / lowlight / proxy object that was
 * created before Task #17's isolation work and therefore has no ACL metadata.
 *
 * Safe to re-run: objects that already have an ACL policy are skipped.
 *
 * Usage (from the workspace root):
 *   pnpm --filter @workspace/api-server run backfill-acl
 *
 * Or directly:
 *   npx tsx artifacts/api-server/scripts/backfill-acl.ts
 */

import { db, gamesTable } from "@workspace/db";
import { isNotNull, or } from "drizzle-orm";
import { ObjectStorageService } from "../src/lib/objectStorage";
import {
  getObjectAclPolicy,
  setObjectAclPolicy,
} from "../src/lib/objectAcl";

interface Stats {
  gamesScanned: number;
  objectsScanned: number;
  objectsAlreadyTagged: number;
  objectsTagged: number;
  objectsMissing: number;
  objectsErrored: number;
}

async function main() {
  const svc = new ObjectStorageService();
  const stats: Stats = {
    gamesScanned: 0,
    objectsScanned: 0,
    objectsAlreadyTagged: 0,
    objectsTagged: 0,
    objectsMissing: 0,
    objectsErrored: 0,
  };

  // Fetch all games that have at least one stored object path AND a known owner.
  const games = await db
    .select({
      id: gamesTable.id,
      ownerId: gamesTable.ownerId,
      videoObjectPath: gamesTable.videoObjectPath,
      highlightObjectPath: gamesTable.highlightObjectPath,
      lowlightObjectPath: gamesTable.lowlightObjectPath,
      videoProxyObjectPath: gamesTable.videoProxyObjectPath,
    })
    .from(gamesTable)
    .where(
      or(
        isNotNull(gamesTable.videoObjectPath),
        isNotNull(gamesTable.highlightObjectPath),
        isNotNull(gamesTable.lowlightObjectPath),
        isNotNull(gamesTable.videoProxyObjectPath),
      ),
    );

  console.log(`Found ${games.length} game(s) with at least one object path.`);

  for (const game of games) {
    stats.gamesScanned++;

    if (game.ownerId == null) {
      console.log(
        `  [SKIP] game ${game.id}: ownerId is NULL — cannot determine owner, skipping all paths`,
      );
      continue;
    }

    const paths: Array<{ label: string; path: string | null }> = [
      { label: "videoObjectPath", path: game.videoObjectPath },
      { label: "highlightObjectPath", path: game.highlightObjectPath },
      { label: "lowlightObjectPath", path: game.lowlightObjectPath },
      { label: "videoProxyObjectPath", path: game.videoProxyObjectPath },
    ];

    for (const { label, path } of paths) {
      if (!path) continue;
      stats.objectsScanned++;

      try {
        // Resolve the object file — this also verifies the object actually exists.
        let objectFile;
        try {
          objectFile = await svc.getObjectEntityFile(path);
        } catch (err: any) {
          if (err?.name === "ObjectNotFoundError") {
            console.log(
              `  [MISSING] game ${game.id} ${label}=${path}: object not found in storage, skipping`,
            );
            stats.objectsMissing++;
            continue;
          }
          throw err;
        }

        // Check whether an ACL policy already exists (idempotency guard).
        const existing = await getObjectAclPolicy(objectFile);
        if (existing != null) {
          console.log(
            `  [SKIP] game ${game.id} ${label}=${path}: ACL already set (owner=${existing.owner})`,
          );
          stats.objectsAlreadyTagged++;
          continue;
        }

        // Write the policy.
        await setObjectAclPolicy(objectFile, {
          owner: String(game.ownerId),
          visibility: "private",
        });

        console.log(
          `  [TAGGED] game ${game.id} ${label}=${path}: owner=${game.ownerId}`,
        );
        stats.objectsTagged++;
      } catch (err) {
        console.error(
          `  [ERROR] game ${game.id} ${label}=${path}:`,
          err,
        );
        stats.objectsErrored++;
      }
    }
  }

  console.log("\n=== Backfill complete ===");
  console.log(`  Games scanned:         ${stats.gamesScanned}`);
  console.log(`  Objects scanned:       ${stats.objectsScanned}`);
  console.log(`  Already tagged:        ${stats.objectsAlreadyTagged}`);
  console.log(`  Newly tagged:          ${stats.objectsTagged}`);
  console.log(`  Missing in storage:    ${stats.objectsMissing}`);
  console.log(`  Errors:                ${stats.objectsErrored}`);

  if (stats.objectsErrored > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
