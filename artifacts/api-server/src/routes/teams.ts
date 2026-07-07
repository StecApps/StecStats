import { Router, type IRouter } from "express";
import { and, eq, inArray, sql } from "drizzle-orm";
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
  GetTeamHighlightParams,
  GetTeamHighlightResponse,
} from "@workspace/api-zod";
import { computePoints } from "../lib/stats";
import { requireAuth } from "../middlewares/requireAuth";
import { getEntitlements } from "../lib/entitlements";
import { getCurrentSeasonStartDate } from "../lib/season";
import { gte } from "drizzle-orm";
import {
  countEligibleMomentsForTeam,
  generateTeamHighlight,
} from "../lib/highlightGenerator";

const router: IRouter = Router();

// Free tier is limited to "current season only" -- modeled as a single team
// (season) per account. Enforced server-side (source of truth) -- the UI
// gate is cosmetic only.
const FREE_TEAM_LIMIT = 1;

// Guards against launching a second season-highlight generation while one is
// already running for the same team (survives concurrent requests).
const teamHighlightInFlight = new Set<number>();
// A DB status of "processing" older than this is considered abandoned (e.g.
// the server restarted mid-job) and may be retried.
const STALE_PROCESSING_MS = 10 * 60 * 1000;

function normalizeHighlightStatus(raw: string | null): "idle" | "processing" | "ready" | "failed" {
  if (raw === "processing" || raw === "ready" || raw === "failed") return raw;
  return "idle";
}

router.get("/teams", requireAuth, async (req, res) => {
  const teams = await db
    .select()
    .from(teamsTable)
    .where(eq(teamsTable.ownerId, req.appUser!.id))
    .orderBy(teamsTable.name);
  res.json(ListTeamsResponse.parse(teams));
});

router.post("/teams", requireAuth, async (req, res) => {
  const body = CreateTeamBody.parse(req.body);
  const ownerId = req.appUser!.id;

  const entitlements = await getEntitlements(req.appUser!.stripeCustomerId, req.appUser!.email);
  if (entitlements.plan === "free") {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(teamsTable)
      .where(eq(teamsTable.ownerId, ownerId));
    if (count >= FREE_TEAM_LIMIT) {
      res.status(403).json({
        error: `Free plan is limited to the current season (${FREE_TEAM_LIMIT} team). Upgrade to Pro for unlimited seasons.`,
        code: "UPGRADE_REQUIRED",
      });
      return;
    }
  }

  const [team] = await db
    .insert(teamsTable)
    .values({ ...body, ownerId })
    .returning();
  res.status(201).json(CreateTeamResponse.parse(team));
});

router.get("/teams/:teamId", requireAuth, async (req, res) => {
  const { teamId } = GetTeamParams.parse(req.params);
  const team = await db.query.teamsTable.findFirst({
    where: and(eq(teamsTable.id, teamId), eq(teamsTable.ownerId, req.appUser!.id)),
  });
  if (!team) {
    res.status(404).json({ error: "Team not found" });
    return;
  }
  res.json(GetTeamResponse.parse(team));
});

router.patch("/teams/:teamId", requireAuth, async (req, res) => {
  const { teamId } = UpdateTeamParams.parse(req.params);
  const body = UpdateTeamBody.parse(req.body);
  const [team] = await db
    .update(teamsTable)
    .set(body)
    .where(and(eq(teamsTable.id, teamId), eq(teamsTable.ownerId, req.appUser!.id)))
    .returning();
  if (!team) {
    res.status(404).json({ error: "Team not found" });
    return;
  }
  res.json(UpdateTeamResponse.parse(team));
});

router.delete("/teams/:teamId", requireAuth, async (req, res) => {
  const { teamId } = DeleteTeamParams.parse(req.params);
  await db
    .delete(teamsTable)
    .where(and(eq(teamsTable.id, teamId), eq(teamsTable.ownerId, req.appUser!.id)));
  res.status(204).send();
});

router.get("/teams/:teamId/games", requireAuth, async (req, res) => {
  const { teamId } = ListTeamGamesParams.parse(req.params);
  const team = await db.query.teamsTable.findFirst({
    where: and(eq(teamsTable.id, teamId), eq(teamsTable.ownerId, req.appUser!.id)),
  });
  if (!team) {
    res.status(404).json({ error: "Team not found" });
    return;
  }

  // Free plan: "current season only" -- a single team record can span
  // multiple real-world seasons of recorded games, so filter by date too.
  // Enforced server-side (source of truth) -- the UI gate is cosmetic only.
  const isFree = (await getEntitlements(req.appUser!.stripeCustomerId, req.appUser!.email)).plan === "free";
  const seasonStart = getCurrentSeasonStartDate();

  const games = await db
    .select()
    .from(gamesTable)
    .where(
      isFree
        ? and(
            eq(gamesTable.teamId, teamId),
            eq(gamesTable.ownerId, req.appUser!.id),
            gte(gamesTable.date, seasonStart),
          )
        : and(eq(gamesTable.teamId, teamId), eq(gamesTable.ownerId, req.appUser!.id)),
    )
    .orderBy(gamesTable.date);

  const gameIds = games.map((g) => g.id);

  const statRows = gameIds.length
    ? await db
        .select({ stat: playerGameStatsTable, playerName: playersTable.name })
        .from(playerGameStatsTable)
        .innerJoin(
          playersTable,
          and(
            eq(playerGameStatsTable.playerId, playersTable.id),
            eq(playersTable.ownerId, req.appUser!.id),
          ),
        )
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
    highlightObjectPath: game.highlightObjectPath ?? null,
    highlightStatus: game.highlightStatus ?? null,
    highlightError: game.highlightError ?? null,
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

router.get("/teams/:teamId/highlight", requireAuth, async (req, res) => {
  const { teamId } = GetTeamHighlightParams.parse(req.params);
  const team = await db.query.teamsTable.findFirst({
    where: and(eq(teamsTable.id, teamId), eq(teamsTable.ownerId, req.appUser!.id)),
  });
  if (!team) {
    res.status(404).json({ error: "Team not found" });
    return;
  }

  const eligibleMoments = await countEligibleMomentsForTeam(teamId);
  res.json(
    GetTeamHighlightResponse.parse({
      status: normalizeHighlightStatus(team.highlightStatus),
      highlightObjectPath: team.highlightObjectPath ?? null,
      error: team.highlightError ?? null,
      eligibleMoments,
    }),
  );
});

router.post("/teams/:teamId/highlight", requireAuth, async (req, res) => {
  const { teamId } = GetTeamHighlightParams.parse(req.params);
  const team = await db.query.teamsTable.findFirst({
    where: and(eq(teamsTable.id, teamId), eq(teamsTable.ownerId, req.appUser!.id)),
  });
  if (!team) {
    res.status(404).json({ error: "Team not found" });
    return;
  }

  const eligibleMoments = await countEligibleMomentsForTeam(teamId);
  if (eligibleMoments === 0) {
    res.status(400).json({
      error: "No highlight-worthy moments were tagged across this team's recorded games",
    });
    return;
  }

  const startedAtMs = team.highlightStartedAt
    ? new Date(team.highlightStartedAt).getTime()
    : 0;
  const staleProcessing =
    team.highlightStatus === "processing" && Date.now() - startedAtMs > STALE_PROCESSING_MS;
  const alreadyRunning =
    teamHighlightInFlight.has(teamId) || (team.highlightStatus === "processing" && !staleProcessing);
  if (!alreadyRunning) {
    teamHighlightInFlight.add(teamId);
    await db
      .update(teamsTable)
      .set({
        highlightStatus: "processing",
        highlightError: null,
        highlightStartedAt: new Date(),
      })
      .where(eq(teamsTable.id, teamId));

    // Fire-and-forget: generation continues after the response is sent.
    void generateTeamHighlight(teamId)
      .catch(() => {})
      .finally(() => teamHighlightInFlight.delete(teamId));
  }

  res.status(202).json(
    GetTeamHighlightResponse.parse({
      status: "processing",
      highlightObjectPath: team.highlightObjectPath ?? null,
      error: null,
      eligibleMoments,
    }),
  );
});

export default router;
