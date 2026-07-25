import { pgTable, serial, text, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const teamsTable = pgTable("teams", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  sport: text("sport").notNull().default("basketball"),
  // See players.ts for why this is nullable at the DB level.
  ownerId: integer("owner_id").references(() => usersTable.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  // Season highlight reel: one combined MP4 built from every game's good
  // plays across the whole team. Mirrors gamesTable's per-game highlight
  // fields (see highlight-reel memory: status is a fire-and-forget state
  // machine that must be recoverable from a stale "processing").
  highlightObjectPath: text("highlight_object_path"),
  highlightStatus: text("highlight_status"),
  highlightError: text("highlight_error"),
  highlightStartedAt: timestamp("highlight_started_at"),
  // Version of the reel-generation code that produced the stored reel.
  // NULL/older than GENERATOR_VERSION (highlightGenerator.ts) means the reel
  // was built with outdated clip-timing logic and is invalidated on read.
  highlightGeneratorVersion: integer("highlight_generator_version"),
});

export const insertTeamSchema = createInsertSchema(teamsTable).omit({
  id: true,
  ownerId: true,
  createdAt: true,
});
export type InsertTeam = z.infer<typeof insertTeamSchema>;
export type Team = typeof teamsTable.$inferSelect;
