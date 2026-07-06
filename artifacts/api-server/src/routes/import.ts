import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, playersTable, teamsTable, gamesTable, playerGameStatsTable } from "@workspace/db";
import { ImportDataBody, ImportDataResponse } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";

const router: IRouter = Router();

router.post("/import", requireAuth, async (req, res) => {
  const body = ImportDataBody.parse(req.body);
  const ownerId = req.appUser!.id;

  let playersCreated = 0;
  let teamsCreated = 0;
  let gamesCreated = 0;
  let statLinesCreated = 0;

  await db.transaction(async (tx) => {
    const playerCache = new Map<string, number>();
    const teamCache = new Map<string, number>();
    const gameCache = new Map<string, number>();

    for (const row of body.rows) {
      let teamId = teamCache.get(row.teamName);
      if (teamId === undefined) {
        const existingTeam = await tx.query.teamsTable.findFirst({
          where: and(eq(teamsTable.name, row.teamName), eq(teamsTable.ownerId, ownerId)),
        });
        if (existingTeam) {
          teamId = existingTeam.id;
        } else {
          const [created] = await tx
            .insert(teamsTable)
            .values({ name: row.teamName, ownerId })
            .returning();
          teamId = created.id;
          teamsCreated += 1;
        }
        teamCache.set(row.teamName, teamId);
      }

      let playerId = playerCache.get(row.playerName);
      if (playerId === undefined) {
        const existingPlayer = await tx.query.playersTable.findFirst({
          where: and(eq(playersTable.name, row.playerName), eq(playersTable.ownerId, ownerId)),
        });
        if (existingPlayer) {
          playerId = existingPlayer.id;
        } else {
          const [created] = await tx
            .insert(playersTable)
            .values({ name: row.playerName, ownerId })
            .returning();
          playerId = created.id;
          playersCreated += 1;
        }
        playerCache.set(row.playerName, playerId);
      }

      const gameKey = `${teamId}|${row.opponent}|${row.date}`;
      let gameId = gameCache.get(gameKey);
      if (gameId === undefined) {
        const existingGame = await tx.query.gamesTable.findFirst({
          where: and(
            eq(gamesTable.teamId, teamId),
            eq(gamesTable.opponent, row.opponent),
            eq(gamesTable.date, row.date),
            eq(gamesTable.ownerId, ownerId),
          ),
        });
        if (existingGame) {
          gameId = existingGame.id;
        } else {
          const [created] = await tx
            .insert(gamesTable)
            .values({
              teamId,
              ownerId,
              opponent: row.opponent,
              date: row.date,
              result: row.result,
              teamScore: row.teamScore,
              opponentScore: row.opponentScore,
            })
            .returning();
          gameId = created.id;
          gamesCreated += 1;
        }
        gameCache.set(gameKey, gameId);
      }

      const existingStat = await tx.query.playerGameStatsTable.findFirst({
        where: and(
          eq(playerGameStatsTable.gameId, gameId),
          eq(playerGameStatsTable.playerId, playerId),
        ),
      });

      const statValues = {
        ftMade: row.ftMade,
        ftAttempted: row.ftAttempted,
        twoMade: row.twoMade,
        twoAttempted: row.twoAttempted,
        threeMade: row.threeMade,
        threeAttempted: row.threeAttempted,
        assists: row.assists,
        rebounds: row.rebounds,
        steals: row.steals,
        turnovers: row.turnovers,
        blocks: row.blocks,
      };

      if (existingStat) {
        await tx
          .update(playerGameStatsTable)
          .set(statValues)
          .where(eq(playerGameStatsTable.id, existingStat.id));
      } else {
        await tx.insert(playerGameStatsTable).values({
          gameId,
          playerId,
          ...statValues,
        });
        statLinesCreated += 1;
      }
    }
  });

  res.json(
    ImportDataResponse.parse({
      playersCreated,
      teamsCreated,
      gamesCreated,
      statLinesCreated,
    }),
  );
});

export default router;
