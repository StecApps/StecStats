import { integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * Durable retention ledger for original game-film uploads.
 *
 * A game row can be replaced or hard-deleted during normal product use, so it
 * cannot be the sole record protecting its original footage. Privacy/account
 * erasure is the explicit exception and removes these records with the account.
 */
export const retainedGameFilmsTable = pgTable(
  "retained_game_films",
  {
    id: serial("id").primaryKey(),
    ownerId: integer("owner_id").notNull().references(() => usersTable.id),
    objectPath: text("object_path").notNull(),
    originalGameId: integer("original_game_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("retained_game_films_object_path_unique").on(table.objectPath),
  ],
);