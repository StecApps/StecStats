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
import { usersTable } from "./users";

export const gameResultEnum = pgEnum("game_result", ["W", "L"]);

export const gamesTable = pgTable("games", {
  id: serial("id").primaryKey(),
  teamId: integer("team_id")
    .notNull()
    .references(() => teamsTable.id, { onDelete: "cascade" }),
  // See players.ts for why this is nullable at the DB level.
  ownerId: integer("owner_id").references(() => usersTable.id),
  opponent: text("opponent").notNull(),
  date: date("date").notNull(),
  result: gameResultEnum("result").notNull(),
  teamScore: integer("team_score").notNull(),
  opponentScore: integer("opponent_score").notNull(),
  videoObjectPath: text("video_object_path"),
  highlightObjectPath: text("highlight_object_path"),
  highlightStatus: text("highlight_status"),
  highlightError: text("highlight_error"),
  highlightStartedAt: timestamp("highlight_started_at"),
  lowlightObjectPath: text("lowlight_object_path"),
  lowlightStatus: text("lowlight_status"),
  lowlightError: text("lowlight_error"),
  lowlightStartedAt: timestamp("lowlight_started_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertGameSchema = createInsertSchema(gamesTable).omit({
  id: true,
  ownerId: true,
  createdAt: true,
});
export type InsertGame = z.infer<typeof insertGameSchema>;
export type Game = typeof gamesTable.$inferSelect;
