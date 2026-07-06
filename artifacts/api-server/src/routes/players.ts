import { Router, type IRouter } from "express";
import { and, eq, sql } from "drizzle-orm";
import { db, playersTable, gamesTable, playerGameStatsTable, teamsTable } from "@workspace/db";
import {
  ListPlayersResponse,
  CreatePlayerBody,
  CreatePlayerResponse,
  GetPlayerParams,
  GetPlayerResponse,
  UpdatePlayerParams,
  UpdatePlayerBody,
  UpdatePlayerResponse,
  DeletePlayerParams,
  GetPlayerSummaryParams,
  GetPlayerSummaryResponse,
  ListPlayerTeamGroupsParams,
  ListPlayerTeamGroupsResponse,
} from "@workspace/api-zod";
import { computePoints, safeDiv } from "../lib/stats";
import { requireAuth } from "../middlewares/requireAuth";
import { getEntitlements } from "../lib/entitlements";

const router: IRouter = Router();

// Free tier is capped at 1 player. Enforced server-side (source of truth) --
// the UI gate is cosmetic only.
const FREE_PLAYER_LIMIT = 1;

router.get("/players", requireAuth, async (req, res) => {
  const players = await db
    .select()
    .from(playersTable)
    .where(eq(playersTable.ownerId, req.appUser!.id))
    .orderBy(playersTable.name);
  res.json(ListPlayersResponse.parse(players));
});

router.post("/players", requireAuth, async (req, res) => {
  const body = CreatePlayerBody.parse(req.body);
  const ownerId = req.appUser!.id;

  const entitlements = await getEntitlements(req.appUser!.stripeCustomerId);
  if (entitlements.plan === "free") {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(playersTable)
      .where(eq(playersTable.ownerId, ownerId));
    if (count >= FREE_PLAYER_LIMIT) {
      res.status(403).json({
        error: `Free plan is limited to ${FREE_PLAYER_LIMIT} player. Upgrade to Pro for unlimited players.`,
        code: "UPGRADE_REQUIRED",
      });
      return;
    }
  }

  const [player] = await db
    .insert(playersTable)
    .values({ ...body, ownerId })
    .returning();
  res.status(201).json(CreatePlayerResponse.parse(player));
});

router.get("/players/:playerId", requireAuth, async (req, res) => {
  const { playerId } = GetPlayerParams.parse(req.params);
  const player = await db.query.playersTable.findFirst({
    where: and(eq(playersTable.id, playerId), eq(playersTable.ownerId, req.appUser!.id)),
  });
  if (!player) {
    res.status(404).json({ error: "Player not found" });
    return;
  }
  res.json(GetPlayerResponse.parse(player));
});

router.patch("/players/:playerId", requireAuth, async (req, res) => {
  const { playerId } = UpdatePlayerParams.parse(req.params);
  const body = UpdatePlayerBody.parse(req.body);
  const [player] = await db
    .update(playersTable)
    .set(body)
    .where(and(eq(playersTable.id, playerId), eq(playersTable.ownerId, req.appUser!.id)))
    .returning();
  if (!player) {
    res.status(404).json({ error: "Player not found" });
    return;
  }
  res.json(UpdatePlayerResponse.parse(player));
});

router.delete("/players/:playerId", requireAuth, async (req, res) => {
  const { playerId } = DeletePlayerParams.parse(req.params);
  await db
    .delete(playersTable)
    .where(and(eq(playersTable.id, playerId), eq(playersTable.ownerId, req.appUser!.id)));
  res.status(204).send();
});

router.get("/players/:playerId/summary", requireAuth, async (req, res) => {
  const { playerId } = GetPlayerSummaryParams.parse(req.params);
  const player = await db.query.playersTable.findFirst({
    where: and(eq(playersTable.id, playerId), eq(playersTable.ownerId, req.appUser!.id)),
  });
  if (!player) {
    res.status(404).json({ error: "Player not found" });
    return;
  }

  const rows = await db
    .select({
      stat: playerGameStatsTable,
      result: gamesTable.result,
    })
    .from(playerGameStatsTable)
    .innerJoin(
      gamesTable,
      and(eq(playerGameStatsTable.gameId, gamesTable.id), eq(gamesTable.ownerId, req.appUser!.id)),
    )
    .where(eq(playerGameStatsTable.playerId, playerId));

  const totals = {
    games: rows.length,
    wins: 0,
    losses: 0,
    points: 0,
    rebounds: 0,
    assists: 0,
    steals: 0,
    turnovers: 0,
    blocks: 0,
    ftMade: 0,
    ftAttempted: 0,
    twoMade: 0,
    twoAttempted: 0,
    threeMade: 0,
    threeAttempted: 0,
  };

  for (const { stat, result } of rows) {
    if (result === "W") totals.wins += 1;
    else totals.losses += 1;
    totals.points += computePoints(stat);
    totals.rebounds += stat.rebounds;
    totals.assists += stat.assists;
    totals.steals += stat.steals;
    totals.turnovers += stat.turnovers;
    totals.blocks += stat.blocks;
    totals.ftMade += stat.ftMade;
    totals.ftAttempted += stat.ftAttempted;
    totals.twoMade += stat.twoMade;
    totals.twoAttempted += stat.twoAttempted;
    totals.threeMade += stat.threeMade;
    totals.threeAttempted += stat.threeAttempted;
  }

  const fgMade = totals.twoMade + totals.threeMade;
  const fgAttempted = totals.twoAttempted + totals.threeAttempted;
  const games = totals.games || 0;

  const summary = {
    playerId: player.id,
    playerName: player.name,
    ...totals,
    ppg: safeDiv(totals.points, games),
    rpg: safeDiv(totals.rebounds, games),
    apg: safeDiv(totals.assists, games),
    spg: safeDiv(totals.steals, games),
    topg: safeDiv(totals.turnovers, games),
    bpg: safeDiv(totals.blocks, games),
    fgPct: safeDiv(fgMade, fgAttempted),
    threePct: safeDiv(totals.threeMade, totals.threeAttempted),
    ftPct: safeDiv(totals.ftMade, totals.ftAttempted),
  };

  res.json(GetPlayerSummaryResponse.parse(summary));
});

router.get("/players/:playerId/teams", requireAuth, async (req, res) => {
  const { playerId } = ListPlayerTeamGroupsParams.parse(req.params);
  const player = await db.query.playersTable.findFirst({
    where: and(eq(playersTable.id, playerId), eq(playersTable.ownerId, req.appUser!.id)),
  });
  if (!player) {
    res.status(404).json({ error: "Player not found" });
    return;
  }

  const rows = await db
    .select({
      teamId: teamsTable.id,
      teamName: teamsTable.name,
      result: gamesTable.result,
    })
    .from(playerGameStatsTable)
    .innerJoin(
      gamesTable,
      and(eq(playerGameStatsTable.gameId, gamesTable.id), eq(gamesTable.ownerId, req.appUser!.id)),
    )
    .innerJoin(
      teamsTable,
      and(eq(gamesTable.teamId, teamsTable.id), eq(teamsTable.ownerId, req.appUser!.id)),
    )
    .where(eq(playerGameStatsTable.playerId, playerId));

  const groups = new Map<
    number,
    { teamId: number; teamName: string; games: number; wins: number; losses: number }
  >();

  for (const row of rows) {
    const existing = groups.get(row.teamId) ?? {
      teamId: row.teamId,
      teamName: row.teamName,
      games: 0,
      wins: 0,
      losses: 0,
    };
    existing.games += 1;
    if (row.result === "W") existing.wins += 1;
    else existing.losses += 1;
    groups.set(row.teamId, existing);
  }

  res.json(ListPlayerTeamGroupsResponse.parse(Array.from(groups.values())));
});

export default router;
