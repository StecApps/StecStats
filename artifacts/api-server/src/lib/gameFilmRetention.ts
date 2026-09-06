import { db, retainedGameFilmsTable } from "@workspace/db";

/** Idempotently preserve a game-film master before its active linkage changes. */
export async function retainGameMasterFilm(
  tx: { insert: typeof db.insert },
  ownerId: number,
  gameId: number,
  objectPath: string,
): Promise<void> {
  await tx.insert(retainedGameFilmsTable)
    .values({ ownerId, originalGameId: gameId, objectPath })
    .onConflictDoNothing();
}