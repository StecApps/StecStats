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
  // Version of the reel-generation code that produced the stored reels.
  // NULL/older than the current GENERATOR_VERSION means the reel was built
  // with outdated clip-timing logic and must be invalidated so it can be
  // rebuilt. See GENERATOR_VERSION in highlightGenerator.ts.
  highlightGeneratorVersion: integer("highlight_generator_version"),
  lowlightGeneratorVersion: integer("lowlight_generator_version"),
  videoOffsetMs: integer("video_offset_ms"),
  videoProxyObjectPath: text("video_proxy_object_path"),
  // Version of the proxy-encoding pipeline that produced videoProxyObjectPath.
  // NULL/stale proxies (e.g. Opus audio that iOS can't play in MP4) are
  // ignored and rebuilt. See PROXY_VERSION in highlightGenerator.ts.
  videoProxyVersion: integer("video_proxy_version"),
  // Set by repair-video when two WebM halves are concatenated.
  // half2StartMs = game-clock timestamp of first event in second half.
  // halftimeGapMs = gap to subtract from second-half event timestamps so
  //                 they map to the correct position in the stitched video.
  videoHalf2StartMs: integer("video_half2_start_ms"),
  videoHalftimeGapMs: integer("video_halftime_gap_ms"),
  // True end of the recorded footage in video-timeline ms, probed from the
  // stored file (WebM tail cluster scan / MP4 header). Used to detect stat
  // events that happened after the recording stopped ("off film").
  videoDurationMs: integer("video_duration_ms"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertGameSchema = createInsertSchema(gamesTable).omit({
  id: true,
  ownerId: true,
  createdAt: true,
});
export type InsertGame = z.infer<typeof insertGameSchema>;
export type Game = typeof gamesTable.$inferSelect;
