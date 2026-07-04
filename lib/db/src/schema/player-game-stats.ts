import { pgTable, serial, integer, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { gamesTable } from "./games";
import { playersTable } from "./players";

export const playerGameStatsTable = pgTable(
  "player_game_stats",
  {
    id: serial("id").primaryKey(),
    gameId: integer("game_id")
      .notNull()
      .references(() => gamesTable.id, { onDelete: "cascade" }),
    playerId: integer("player_id")
      .notNull()
      .references(() => playersTable.id, { onDelete: "cascade" }),
    ftMade: integer("ft_made").notNull().default(0),
    ftAttempted: integer("ft_attempted").notNull().default(0),
    twoMade: integer("two_made").notNull().default(0),
    twoAttempted: integer("two_attempted").notNull().default(0),
    threeMade: integer("three_made").notNull().default(0),
    threeAttempted: integer("three_attempted").notNull().default(0),
    assists: integer("assists").notNull().default(0),
    rebounds: integer("rebounds").notNull().default(0),
    steals: integer("steals").notNull().default(0),
    turnovers: integer("turnovers").notNull().default(0),
    blocks: integer("blocks").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [unique().on(table.gameId, table.playerId)],
);

export const insertPlayerGameStatSchema = createInsertSchema(
  playerGameStatsTable,
).omit({
  id: true,
  createdAt: true,
});
export type InsertPlayerGameStat = z.infer<typeof insertPlayerGameStatSchema>;
export type PlayerGameStat = typeof playerGameStatsTable.$inferSelect;
