import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import {
  db,
  gamesTable,
  playerGameStatsTable,
  playersTable,
  teamsTable,
  gameEventsTable,
} from "@workspace/db";
import {
  CreateGameBody,
  CreateGameResponse,
  GetGameParams,
  GetGameResponse,
  UpdateGameParams,
  UpdateGameBody,
  UpdateGameResponse,
  DeleteGameParams,
} from "@workspace/api-zod";
import { computePoints } from "../lib/stats";
import { ObjectStorageService } from "../lib/objectStorage";
import { requireAuth } from "../middlewares/requireAuth";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

async function serializeGame(gameId: number) {
  const game = await db.query.gamesTable.findFirst({ where: eq(gamesTable.id, gameId) });
  if (!game) return null;

  const team = await db.query.teamsTable.findFirst({ where: eq(teamsTable.id, game.teamId) });

  const statRows = await db
    .select({ stat: playerGameStatsTable, playerName: playersTable.name })
    .from(playerGameStatsTable)
    .innerJoin(playersTable, eq(playerGameStatsTable.playerId, playersTable.id))
    .where(eq(playerGameStatsTable.gameId, gameId));

  const eventRows = await db.query.gameEventsTable.findMany({
    where: eq(gameEventsTable.gameId, gameId),
    orderBy: (events, { asc }) => [asc(events.videoTimestampMs)],
  });

  return {
    id: game.id,
    teamId: game.teamId,
    teamName: team?.name ?? "",
    opponent: game.opponent,
    date: game.date,
    result: game.result,
    teamScore: game.teamScore,
    opponentScore: game.opponentScore,
    videoObjectPath: game.videoObjectPath,
    highlightObjectPath: game.highlightObjectPath ?? null,
    highlightStatus: game.highlightStatus ?? null,
    highlightError: game.highlightError ?? null,
    createdAt: game.createdAt,
    stats: statRows.map(({ stat, playerName }) => ({
      playerId: stat.playerId,
      playerName,
      ftMade: stat.ftMade,
      ftAttempted: stat.ftAttempted,
      twoMade: stat.twoMade,
      twoAttempted: stat.twoAttempted,
      threeMade: stat.threeMade,
      threeAttempted: stat.threeAttempted,
      points: computePoints(stat),
      assists: stat.assists,
      rebounds: stat.rebounds,
      steals: stat.steals,
      turnovers: stat.turnovers,
      blocks: stat.blocks,
    })),
    events: eventRows.map((event) => ({
      playerId: event.playerId,
      statField: event.statField,
      delta: event.delta,
      videoTimestampMs: event.videoTimestampMs,
    })),
  };
}

router.post("/games", requireAuth, async (req, res) => {
  const body = CreateGameBody.parse(req.body);

  const game = await db.transaction(async (tx) => {
    const [createdGame] = await tx
      .insert(gamesTable)
      .values({
        teamId: body.teamId,
        opponent: body.opponent,
        date: body.date.toISOString().slice(0, 10),
        result: body.result,
        teamScore: body.teamScore,
        opponentScore: body.opponentScore,
        videoObjectPath: body.videoObjectPath
          ? objectStorageService.normalizeObjectEntityPath(body.videoObjectPath)
          : null,
      })
      .returning();

    if (body.stats.length > 0) {
      await tx.insert(playerGameStatsTable).values(
        body.stats.map((stat) => ({
          gameId: createdGame.id,
          ...stat,
        })),
      );
    }

    if (body.events.length > 0) {
      await tx.insert(gameEventsTable).values(
        body.events.map((event) => ({
          gameId: createdGame.id,
          ...event,
        })),
      );
    }

    return createdGame;
  });

  const serialized = await serializeGame(game.id);
  res.status(201).json(CreateGameResponse.parse(serialized));
});

router.get("/games/:gameId", requireAuth, async (req, res) => {
  const { gameId } = GetGameParams.parse(req.params);
  const serialized = await serializeGame(gameId);
  if (!serialized) {
    res.status(404).json({ error: "Game not found" });
    return;
  }
  res.json(GetGameResponse.parse(serialized));
});

router.patch("/games/:gameId", requireAuth, async (req, res) => {
  const { gameId } = UpdateGameParams.parse(req.params);
  const body = UpdateGameBody.parse(req.body);

  const existing = await db.query.gamesTable.findFirst({ where: eq(gamesTable.id, gameId) });
  if (!existing) {
    res.status(404).json({ error: "Game not found" });
    return;
  }

  await db.transaction(async (tx) => {
    await tx
      .update(gamesTable)
      .set({
        teamId: body.teamId,
        opponent: body.opponent,
        date: body.date.toISOString().slice(0, 10),
        result: body.result,
        teamScore: body.teamScore,
        opponentScore: body.opponentScore,
        videoObjectPath: body.videoObjectPath
          ? objectStorageService.normalizeObjectEntityPath(body.videoObjectPath)
          : null,
        // Editing stats/events/video invalidates any existing highlight reel.
        highlightObjectPath: null,
        highlightStatus: "idle",
        highlightError: null,
        highlightStartedAt: null,
      })
      .where(eq(gamesTable.id, gameId));

    await tx.delete(playerGameStatsTable).where(eq(playerGameStatsTable.gameId, gameId));
    await tx.delete(gameEventsTable).where(eq(gameEventsTable.gameId, gameId));

    if (body.stats.length > 0) {
      await tx.insert(playerGameStatsTable).values(
        body.stats.map((stat) => ({
          gameId,
          ...stat,
        })),
      );
    }

    if (body.events.length > 0) {
      await tx.insert(gameEventsTable).values(
        body.events.map((event) => ({
          gameId,
          ...event,
        })),
      );
    }
  });

  const serialized = await serializeGame(gameId);
  res.json(UpdateGameResponse.parse(serialized));
});

router.delete("/games/:gameId", requireAuth, async (req, res) => {
  const { gameId } = DeleteGameParams.parse(req.params);
  await db.delete(gamesTable).where(eq(gamesTable.id, gameId));
  res.status(204).send();
});

export default router;
