import { Router, type IRouter } from "express";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  teamsTable,
  gamesTable,
  playerGameStatsTable,
  playersTable,
  gameEventsTable,
} from "@workspace/db";
import {
  ListTeamsResponse,
  CreateTeamBody,
  CreateTeamResponse,
  GetTeamParams,
  GetTeamResponse,
  UpdateTeamParams,
  UpdateTeamBody,
  UpdateTeamResponse,
  DeleteTeamParams,
  ListTeamGamesParams,
  ListTeamGamesResponse,
} from "@workspace/api-zod";
import { computePoints } from "../lib/stats";

const router: IRouter = Router();

router.get("/teams", async (_req, res) => {
  const teams = await db.select().from(teamsTable).orderBy(teamsTable.name);
  res.json(ListTeamsResponse.parse(teams));
});

router.post("/teams", async (req, res) => {
  const body = CreateTeamBody.parse(req.body);
  const [team] = await db.insert(teamsTable).values(body).returning();
  res.status(201).json(CreateTeamResponse.parse(team));
});

router.get("/teams/:teamId", async (req, res) => {
  const { teamId } = GetTeamParams.parse(req.params);
  const team = await db.query.teamsTable.findFirst({ where: eq(teamsTable.id, teamId) });
  if (!team) {
    res.status(404).json({ error: "Team not found" });
    return;
  }
  res.json(GetTeamResponse.parse(team));
});

router.patch("/teams/:teamId", async (req, res) => {
  const { teamId } = UpdateTeamParams.parse(req.params);
  const body = UpdateTeamBody.parse(req.body);
  const [team] = await db
    .update(teamsTable)
    .set(body)
    .where(eq(teamsTable.id, teamId))
    .returning();
  if (!team) {
    res.status(404).json({ error: "Team not found" });
    return;
  }
  res.json(UpdateTeamResponse.parse(team));
});

router.delete("/teams/:teamId", async (req, res) => {
  const { teamId } = DeleteTeamParams.parse(req.params);
  await db.delete(teamsTable).where(eq(teamsTable.id, teamId));
  res.status(204).send();
});

router.get("/teams/:teamId/games", async (req, res) => {
  const { teamId } = ListTeamGamesParams.parse(req.params);
  const team = await db.query.teamsTable.findFirst({ where: eq(teamsTable.id, teamId) });
  if (!team) {
    res.status(404).json({ error: "Team not found" });
    return;
  }

  const games = await db
    .select()
    .from(gamesTable)
    .where(eq(gamesTable.teamId, teamId))
    .orderBy(gamesTable.date);

  const gameIds = games.map((g) => g.id);

  const statRows = gameIds.length
    ? await db
        .select({ stat: playerGameStatsTable, playerName: playersTable.name })
        .from(playerGameStatsTable)
        .innerJoin(playersTable, eq(playerGameStatsTable.playerId, playersTable.id))
        .where(inArray(playerGameStatsTable.gameId, gameIds))
    : [];

  const statsByGame = new Map<number, typeof statRows>();
  for (const row of statRows) {
    const list = statsByGame.get(row.stat.gameId) ?? [];
    list.push(row);
    statsByGame.set(row.stat.gameId, list);
  }

  const eventRows = gameIds.length
    ? await db.query.gameEventsTable.findMany({
        where: inArray(gameEventsTable.gameId, gameIds),
        orderBy: (events, { asc }) => [asc(events.videoTimestampMs)],
      })
    : [];

  const eventsByGame = new Map<number, typeof eventRows>();
  for (const event of eventRows) {
    const list = eventsByGame.get(event.gameId) ?? [];
    list.push(event);
    eventsByGame.set(event.gameId, list);
  }

  const response = games.map((game) => ({
    id: game.id,
    teamId: game.teamId,
    teamName: team.name,
    opponent: game.opponent,
    date: game.date,
    result: game.result,
    teamScore: game.teamScore,
    opponentScore: game.opponentScore,
    videoObjectPath: game.videoObjectPath,
    createdAt: game.createdAt,
    stats: (statsByGame.get(game.id) ?? []).map(({ stat, playerName }) => ({
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
    events: (eventsByGame.get(game.id) ?? []).map((event) => ({
      playerId: event.playerId,
      statField: event.statField,
      delta: event.delta,
      videoTimestampMs: event.videoTimestampMs,
    })),
  }));

  res.json(ListTeamGamesResponse.parse(response));
});

export default router;
