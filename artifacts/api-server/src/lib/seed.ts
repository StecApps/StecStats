import { db, playersTable, gamesTable } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { logger } from "./logger";

const SEED_PLAYERS = ["Amyra Stec", "Javiana Stec"];

export async function seedDatabase(): Promise<void> {
  const existing = await db.select({ id: playersTable.id }).from(playersTable).limit(1);
  if (existing.length > 0) {
    return;
  }

  await db.insert(playersTable).values(SEED_PLAYERS.map((name) => ({ name })));
  logger.info({ players: SEED_PLAYERS }, "Seeded initial players");
}

/**
 * One-time fix: game 154 has a 2nd-half-only video (35 min).
 * Events were recorded with a running clock so 2nd-half timestamps start
 * at ~2,205,276 ms. Set the offset once so seeks land correctly.
 */
export async function applyVideoOffsetFixes(): Promise<void> {
  try {
    await db
      .update(gamesTable)
      .set({ videoOffsetMs: 1_809_782 })
      .where(eq(gamesTable.id, 154));
    logger.info({ gameId: 154, videoOffsetMs: 1_809_782 }, "Applied video offset fix for game 154");
  } catch (err) {
    logger.warn({ err }, "Could not apply video offset fix for game 154 (may not exist in this env)");
  }
}
