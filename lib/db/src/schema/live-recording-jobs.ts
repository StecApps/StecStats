import { pgTable, serial, text, integer, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { gamesTable } from "./games";
import { liveSessionsTable } from "./live-sessions";

export const liveRecordingJobsTable = pgTable("live_recording_jobs", {
  id: serial("id").primaryKey(),
  liveSessionId: integer("live_session_id").notNull().references(() => liveSessionsTable.id, { onDelete: "cascade" }),
  gameId: integer("game_id").notNull().references(() => gamesTable.id, { onDelete: "cascade" }),
  ownerId: integer("owner_id").notNull(),
  dailyRoomName: text("daily_room_name").notNull(),
  dailyRecordingId: text("daily_recording_id"),
  status: text("status").notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at").notNull().defaultNow(),
  leaseToken: text("lease_token"),
  leaseExpiresAt: timestamp("lease_expires_at"),
  objectPath: text("object_path"),
  lastError: text("last_error"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  sessionGameUnique: uniqueIndex("live_recording_jobs_session_game_unique").on(table.liveSessionId, table.gameId),
  dueIndex: index("live_recording_jobs_due_idx").on(table.status, table.nextAttemptAt),
}));

export type LiveRecordingJob = typeof liveRecordingJobsTable.$inferSelect;