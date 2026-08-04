/**
 * DB integration test — Task #148
 *
 * Confirms that renaming a player only modifies the `name` column and leaves
 * all FK-linked stats (player_game_stats) and career totals unchanged.
 *
 * No HTTP server or auth required: this test operates directly against the
 * database via drizzle, mirroring exactly what PATCH /api/players/:id does
 * (a single UPDATE players SET name = … WHERE id = …).
 */

import { describe, it, expect, afterEach } from "vitest";
import { db } from "@workspace/db";
import {
  playersTable,
  teamsTable,
  gamesTable,
  playerGameStatsTable,
} from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";

// IDs of rows created by this test; cleaned up in afterEach.
const cleanup: { playerIds: number[]; teamIds: number[]; gameIds: number[] } = {
  playerIds: [],
  teamIds: [],
  gameIds: [],
};

afterEach(async () => {
  // Delete in reverse FK order (stats cascade from games/players)
  if (cleanup.gameIds.length) {
    await db
      .delete(gamesTable)
      .where(
        sql`${gamesTable.id} = ANY(${sql.raw(
          "ARRAY[" + cleanup.gameIds.join(",") + "]::int[]",
        )})`,
      );
  }
  if (cleanup.teamIds.length) {
    await db
      .delete(teamsTable)
      .where(
        sql`${teamsTable.id} = ANY(${sql.raw(
          "ARRAY[" + cleanup.teamIds.join(",") + "]::int[]",
        )})`,
      );
  }
  if (cleanup.playerIds.length) {
    await db
      .delete(playersTable)
      .where(
        sql`${playersTable.id} = ANY(${sql.raw(
          "ARRAY[" + cleanup.playerIds.join(",") + "]::int[]",
        )})`,
      );
  }
  cleanup.playerIds = [];
  cleanup.teamIds = [];
  cleanup.gameIds = [];
});

/**
 * Compute career totals for a player directly from player_game_stats rows.
 * Mirrors the aggregation logic in GET /api/players/:id/summary.
 */
async function careerTotals(playerId: number) {
  const rows = await db
    .select({
      twoMade: playerGameStatsTable.twoMade,
      threeMade: playerGameStatsTable.threeMade,
      ftMade: playerGameStatsTable.ftMade,
      ftAttempted: playerGameStatsTable.ftAttempted,
      twoAttempted: playerGameStatsTable.twoAttempted,
      threeAttempted: playerGameStatsTable.threeAttempted,
      assists: playerGameStatsTable.assists,
      rebounds: playerGameStatsTable.rebounds,
      steals: playerGameStatsTable.steals,
      turnovers: playerGameStatsTable.turnovers,
      blocks: playerGameStatsTable.blocks,
      gameId: playerGameStatsTable.gameId,
    })
    .from(playerGameStatsTable)
    .where(eq(playerGameStatsTable.playerId, playerId));

  return {
    gamesPlayed: rows.length,
    points: rows.reduce((s, r) => s + r.twoMade * 2 + r.threeMade * 3 + r.ftMade, 0),
    assists: rows.reduce((s, r) => s + r.assists, 0),
    rebounds: rows.reduce((s, r) => s + r.rebounds, 0),
    steals: rows.reduce((s, r) => s + r.steals, 0),
    blocks: rows.reduce((s, r) => s + r.blocks, 0),
    turnovers: rows.reduce((s, r) => s + r.turnovers, 0),
    ftMade: rows.reduce((s, r) => s + r.ftMade, 0),
    ftAttempted: rows.reduce((s, r) => s + r.ftAttempted, 0),
    twoMade: rows.reduce((s, r) => s + r.twoMade, 0),
    twoAttempted: rows.reduce((s, r) => s + r.twoAttempted, 0),
    threeMade: rows.reduce((s, r) => s + r.threeMade, 0),
    threeAttempted: rows.reduce((s, r) => s + r.threeAttempted, 0),
    gameIds: rows.map((r) => r.gameId).sort(),
  };
}

describe("player rename — FK integrity", () => {
  it("career totals and per-game stat rows are identical before and after rename", async () => {
    // ── Seed ────────────────────────────────────────────────────────────────
    const [player] = await db
      .insert(playersTable)
      .values({ name: "Rename Test Player" })
      .returning();
    cleanup.playerIds.push(player.id);

    const [team] = await db
      .insert(teamsTable)
      .values({ name: "Rename Test Team", sport: "basketball" })
      .returning();
    cleanup.teamIds.push(team.id);

    // Game 1
    const [game1] = await db
      .insert(gamesTable)
      .values({
        teamId: team.id,
        opponent: "Opponent A",
        date: "2025-10-01",
        result: "W",
        teamScore: 90,
        opponentScore: 75,
      })
      .returning();
    cleanup.gameIds.push(game1.id);

    await db.insert(playerGameStatsTable).values({
      gameId: game1.id,
      playerId: player.id,
      twoMade: 7, twoAttempted: 12,
      threeMade: 2, threeAttempted: 5,
      ftMade: 3, ftAttempted: 4,
      assists: 5, rebounds: 8,
      steals: 2, turnovers: 3, blocks: 1,
    });

    // Game 2 — verifies multi-game history also survives
    const [game2] = await db
      .insert(gamesTable)
      .values({
        teamId: team.id,
        opponent: "Opponent B",
        date: "2025-10-08",
        result: "L",
        teamScore: 68,
        opponentScore: 72,
      })
      .returning();
    cleanup.gameIds.push(game2.id);

    await db.insert(playerGameStatsTable).values({
      gameId: game2.id,
      playerId: player.id,
      twoMade: 4, twoAttempted: 9,
      threeMade: 1, threeAttempted: 4,
      ftMade: 2, ftAttempted: 2,
      assists: 3, rebounds: 5,
      steals: 1, turnovers: 2, blocks: 0,
    });

    // ── Baseline ─────────────────────────────────────────────────────────────
    const before = await careerTotals(player.id);

    // Sanity-check the seed:
    //   game1: 7×2 + 2×3 + 3  = 14 + 6 + 3  = 23
    //   game2: 4×2 + 1×3 + 2  =  8 + 3 + 2  = 13
    //   total: 23 + 13 = 36
    expect(before.gamesPlayed).toBe(2);
    expect(before.points).toBe(36);
    expect(before.assists).toBe(8);
    expect(before.rebounds).toBe(13);
    expect(before.steals).toBe(3);
    expect(before.blocks).toBe(1);
    expect(before.turnovers).toBe(5);
    expect(before.gameIds).toEqual([game1.id, game2.id].sort());

    // ── Rename ───────────────────────────────────────────────────────────────
    // This is the exact operation PATCH /api/players/:id performs.
    const [updated] = await db
      .update(playersTable)
      .set({ name: "Rename Test Player — RENAMED" })
      .where(eq(playersTable.id, player.id))
      .returning();

    expect(updated.name).toBe("Rename Test Player — RENAMED");

    // ── Post-rename assertions ───────────────────────────────────────────────
    const after = await careerTotals(player.id);

    // Every stat field must be byte-for-byte identical
    expect(after.gamesPlayed).toBe(before.gamesPlayed);
    expect(after.points).toBe(before.points);
    expect(after.assists).toBe(before.assists);
    expect(after.rebounds).toBe(before.rebounds);
    expect(after.steals).toBe(before.steals);
    expect(after.blocks).toBe(before.blocks);
    expect(after.turnovers).toBe(before.turnovers);
    expect(after.ftMade).toBe(before.ftMade);
    expect(after.ftAttempted).toBe(before.ftAttempted);
    expect(after.twoMade).toBe(before.twoMade);
    expect(after.twoAttempted).toBe(before.twoAttempted);
    expect(after.threeMade).toBe(before.threeMade);
    expect(after.threeAttempted).toBe(before.threeAttempted);

    // Both game IDs must still appear in the player's history
    expect(after.gameIds).toEqual(before.gameIds);
  });

  it("per-game stat rows still join to the correct player after rename", async () => {
    const [player] = await db
      .insert(playersTable)
      .values({ name: "Join Test Player" })
      .returning();
    cleanup.playerIds.push(player.id);

    const [team] = await db
      .insert(teamsTable)
      .values({ name: "Join Test Team", sport: "basketball" })
      .returning();
    cleanup.teamIds.push(team.id);

    const [game] = await db
      .insert(gamesTable)
      .values({
        teamId: team.id,
        opponent: "Away Squad",
        date: "2025-11-15",
        result: "W",
        teamScore: 88,
        opponentScore: 72,
      })
      .returning();
    cleanup.gameIds.push(game.id);

    await db.insert(playerGameStatsTable).values({
      gameId: game.id,
      playerId: player.id,
      twoMade: 7, twoAttempted: 12,
      threeMade: 2, threeAttempted: 5,
      ftMade: 3, ftAttempted: 4,
      assists: 5, rebounds: 8,
      steals: 2, turnovers: 3, blocks: 1,
    });

    // Rename
    await db
      .update(playersTable)
      .set({ name: "Join Test Player — RENAMED" })
      .where(eq(playersTable.id, player.id));

    // Join player_game_stats → players — must still resolve and show new name
    const rows = await db
      .select({
        opponent: gamesTable.opponent,
        date: gamesTable.date,
        playerName: playersTable.name,
        twoMade: playerGameStatsTable.twoMade,
        assists: playerGameStatsTable.assists,
        rebounds: playerGameStatsTable.rebounds,
      })
      .from(playerGameStatsTable)
      .innerJoin(playersTable, eq(playerGameStatsTable.playerId, playersTable.id))
      .innerJoin(gamesTable, eq(playerGameStatsTable.gameId, gamesTable.id))
      .where(eq(playerGameStatsTable.playerId, player.id));

    expect(rows).toHaveLength(1);
    expect(rows[0].playerName).toBe("Join Test Player — RENAMED");
    expect(rows[0].opponent).toBe("Away Squad");
    expect(rows[0].twoMade).toBe(7);
    expect(rows[0].assists).toBe(5);
    expect(rows[0].rebounds).toBe(8);
  });
});
