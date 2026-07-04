import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { gamesTable } from "./games";
import { playersTable } from "./players";

export const gameEventsTable = pgTable("game_events", {
  id: serial("id").primaryKey(),
  gameId: integer("game_id")
    .notNull()
    .references(() => gamesTable.id, { onDelete: "cascade" }),
  playerId: integer("player_id")
    .notNull()
    .references(() => playersTable.id, { onDelete: "cascade" }),
  statField: text("stat_field").notNull(),
  delta: integer("delta").notNull(),
  videoTimestampMs: integer("video_timestamp_ms").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertGameEventSchema = createInsertSchema(gameEventsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertGameEvent = z.infer<typeof insertGameEventSchema>;
export type GameEvent = typeof gameEventsTable.$inferSelect;
