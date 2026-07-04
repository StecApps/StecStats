import {
  pgTable,
  serial,
  text,
  integer,
  date,
  timestamp,
  pgEnum,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { teamsTable } from "./teams";

export const gameResultEnum = pgEnum("game_result", ["W", "L"]);

export const gamesTable = pgTable("games", {
  id: serial("id").primaryKey(),
  teamId: integer("team_id")
    .notNull()
    .references(() => teamsTable.id, { onDelete: "cascade" }),
  opponent: text("opponent").notNull(),
  date: date("date").notNull(),
  result: gameResultEnum("result").notNull(),
  teamScore: integer("team_score").notNull(),
  opponentScore: integer("opponent_score").notNull(),
  videoObjectPath: text("video_object_path"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertGameSchema = createInsertSchema(gamesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertGame = z.infer<typeof insertGameSchema>;
export type Game = typeof gamesTable.$inferSelect;
