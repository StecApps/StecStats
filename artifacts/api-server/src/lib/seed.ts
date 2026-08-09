import { db, playersTable, gamesTable } from "@workspace/db";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { logger } from "./logger";

const SEED_PLAYERS = ["Amyra Stec", "Javiana Stec"];

export async function seedDatabase(): Promise<void> {
  const existing = await db.select({ id: playersTable.id }).from(playersTable).limit(1);
  if (existing.length > 0) {
    return;
  }

  await db.insert(playersTable).values(SEED_PLAYERS.map((name) => ({ name })));
  logger.info({ players: SEED_PLAYERS }, "Seeded initial players");
}

/**
 * One-time data fixes for games whose video only covers part of the game.
 * Events were recorded with a running stat clock, so when the footage starts
 * mid-game the event timestamps must be shifted by videoOffsetMs to land on
 * the right spot in the video.
 *
 * Each fix is applied only when the game has NO offset yet (videoOffsetMs is
 * null) OR still holds a superseded value from an earlier version of this
 * list, so a manual adjustment made later in the UI is never overwritten on
 * the next boot.
 *
 * When a fix applies, any stored highlight/lowlight reels are cleared too —
 * their clips were cut with the old sync and must be rebuilt.
 */
const VIDEO_OFFSET_FIXES: ReadonlyArray<{
  gameId: number;
  videoOffsetMs: number;
  /** Earlier auto-applied values this fix may replace. Manual values are never touched. */
  supersedes?: readonly number[];
}> = [
  // Game 154: 2nd-half-only video (35 min); 2nd-half timestamps start ~2,205,276 ms.
  { gameId: 154, videoOffsetMs: 1_809_782 },
  // Game 158: the live stream dropped during the first half and the recording
  // resumed mid-second-half. Calibrated against the user's CONFIRMED anchor:
  // the first 3pt miss on film (event at stat 37:31.368 = 2,251,368 ms) is
  // visible at video 4:27 (267,000 ms). offset = 2,251,368 - 267,000.
  // Verified against prod events: the same 8 events stay on film and the last
  // stat (58:18.060) lands at video 25:14 inside the 25:55 footage.
  // Supersedes the earlier estimate calibrated to a misread anchor of 3:29.
  { gameId: 158, videoOffsetMs: 1_984_368, supersedes: [2_042_368] },
];

export async function applyVideoOffsetFixes(): Promise<void> {
  for (const fix of VIDEO_OFFSET_FIXES) {
    try {
      const replaceable = fix.supersedes?.length
        ? or(
            isNull(gamesTable.videoOffsetMs),
            inArray(gamesTable.videoOffsetMs, [...fix.supersedes]),
          )
        : isNull(gamesTable.videoOffsetMs);
      const updated = await db
        .update(gamesTable)
        .set({
          videoOffsetMs: fix.videoOffsetMs,
          // Reels cut with the old (or missing) sync are stale — clear them
          // so they regenerate from the corrected event→video mapping.
          highlightObjectPath: null,
          highlightStatus: null,
          highlightError: null,
          highlightStartedAt: null,
          highlightGeneratorVersion: null,
          lowlightObjectPath: null,
          lowlightStatus: null,
          lowlightError: null,
          lowlightStartedAt: null,
          lowlightGeneratorVersion: null,
        })
        .where(and(eq(gamesTable.id, fix.gameId), replaceable))
        .returning({ id: gamesTable.id });
      if (updated.length > 0) {
        logger.info(
          { gameId: fix.gameId, videoOffsetMs: fix.videoOffsetMs },
          "Applied video offset fix",
        );
      }
    } catch (err) {
      logger.warn(
        { err, gameId: fix.gameId },
        "Could not apply video offset fix (game may not exist in this env)",
      );
    }
  }
}

/**
 * Idempotent boot-time schema additions.
 *
 * Columns that cannot be created through drizzle-kit push (e.g. due to a
 * pre-existing type-cast conflict on an unrelated column) are applied here via
 * raw SQL with `IF NOT EXISTS` guards. Safe to run on every boot — no-ops when
 * the column already exists.
 */
export async function applySchemaAdditions(): Promise<void> {
  // Added for YouTube highlight upload persistence. The column stores the
  // YouTube video URL after a successful upload so the mobile app can
  // re-surface the "View on YouTube" link across remounts.
  await db.execute(
    sql`ALTER TABLE games ADD COLUMN IF NOT EXISTS highlight_youtube_url text`,
  );
  logger.info("Schema additions applied (highlight_youtube_url)");
}
