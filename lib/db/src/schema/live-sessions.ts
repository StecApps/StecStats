import { pgTable, serial, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const liveSessionsTable = pgTable("live_sessions", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(),
  opponent: text("opponent").notNull(),
  teamName: text("team_name").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
});

export const insertLiveSessionSchema = createInsertSchema(liveSessionsTable).omit({
  id: true,
  createdAt: true,
  lastSeenAt: true,
});
export type InsertLiveSession = z.infer<typeof insertLiveSessionSchema>;
export type LiveSessionRow = typeof liveSessionsTable.$inferSelect;
