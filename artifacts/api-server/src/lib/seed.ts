import { db, playersTable } from "@workspace/db";
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
