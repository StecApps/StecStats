import { pgTable, serial, text, boolean, timestamp, integer } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const liveSessionsTable = pgTable("live_sessions", {
  id: serial("id").primaryKey(),
  ownerId: integer("owner_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  code: text("code").notNull().unique(),
  opponent: text("opponent").notNull(),
  teamName: text("team_name").notNull(),
  active: boolean("active").notNull().default(true),
  teamScore: integer("team_score").notNull().default(0),
  opponentScore: integer("opponent_score").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
  dailyRoomName: text("daily_room_name"),
  dailyRoomUrl: text("daily_room_url"),
  dailyRecordingId: text("daily_recording_id"),
  dailyRecordingStatus: text("daily_recording_status"),
});

export const insertLiveSessionSchema = createInsertSchema(liveSessionsTable).omit({
  id: true,
  createdAt: true,
  lastSeenAt: true,
});
export type InsertLiveSession = z.infer<typeof insertLiveSessionSchema>;
export type LiveSessionRow = typeof liveSessionsTable.$inferSelect;
