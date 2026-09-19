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
  youtubeBroadcastId: text("youtube_broadcast_id"),
  youtubeStreamId: text("youtube_stream_id"),
  youtubeVideoId: text("youtube_video_id"),
  youtubeWatchUrl: text("youtube_watch_url"),
  youtubeRtmpUrl: text("youtube_rtmp_url"),
  youtubeStreamKey: text("youtube_stream_key"),
  youtubeLifecycleStatus: text("youtube_lifecycle_status"),
  youtubeLifecycleError: text("youtube_lifecycle_error"),
  youtubeEndingAt: timestamp("youtube_ending_at"),
  youtubeAttemptToken: text("youtube_attempt_token"),
  youtubeAttemptLeaseUntil: timestamp("youtube_attempt_lease_until"),
  youtubeCleanupBroadcastId: text("youtube_cleanup_broadcast_id"),
  youtubeCleanupStreamId: text("youtube_cleanup_stream_id"),
  youtubeFinalizerClaimToken: text("youtube_finalizer_claim_token"),
  youtubeFinalizerClaimedUntil: timestamp("youtube_finalizer_claimed_until"),
});

export const insertLiveSessionSchema = createInsertSchema(liveSessionsTable).omit({
  id: true,
  createdAt: true,
  lastSeenAt: true,
});
export type InsertLiveSession = z.infer<typeof insertLiveSessionSchema>;
export type LiveSessionRow = typeof liveSessionsTable.$inferSelect;
