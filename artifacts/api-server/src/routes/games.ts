import { Router, type IRouter } from "express";
import { and, eq, inArray } from "drizzle-orm";
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
import { getObjectAclPolicy, setObjectAclPolicy } from "../lib/objectAcl";
import { requireAuth } from "../middlewares/requireAuth";
import { getEntitlements } from "../lib/entitlements";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

async function assertPlayersOwned(
  playerIds: number[],
  ownerId: number,
): Promise<boolean> {
  const uniqueIds = Array.from(new Set(playerIds));
  if (uniqueIds.length === 0) return true;
  const owned = await db.query.playersTable.findMany({
    where: and(inArray(playersTable.id, uniqueIds), eq(playersTable.ownerId, ownerId)),
  });
  return owned.length === uniqueIds.length;
}

/**
 * Claims an object path for a game's video, guarding against cross-tenant
 * object hijacking: a caller may only link an object that either has no ACL
 * policy yet (fresh, server-issued upload) or is already owned by them. This
 * prevents an attacker from referencing another tenant's already-uploaded
 * object path in their own game to reassign its ACL ownership to themselves.
 * ACL write failures are treated as request failures rather than logged and
 * ignored, so a game can never end up DB-linked to an object whose ACL
 * ownership doesn't actually match.
 *
 * DB linkage is checked in addition to the ACL policy: even if an object was
 * never given an ACL (e.g. a legacy row), we still reject the claim if any
 * *other* tenant's game or highlight already references this exact path.
 * This closes the gap where ACL-missing objects linked to another tenant
 * could otherwise be "claimed" by referencing their path.
 */
async function claimVideoObjectPath(objectPath: string, ownerId: number): Promise<void> {
  const [linkedByVideoPath, linkedByHighlightPath] = await Promise.all([
    db.query.gamesTable.findFirst({ where: eq(gamesTable.videoObjectPath, objectPath) }),
    db.query.gamesTable.findFirst({ where: eq(gamesTable.highlightObjectPath, objectPath) }),
  ]);
  for (const linked of [linkedByVideoPath, linkedByHighlightPath]) {
    if (linked && linked.ownerId != null && linked.ownerId !== ownerId) {
      throw new ObjectOwnershipConflictError();
    }
  }

  const objectFile = await objectStorageService.getObjectEntityFile(objectPath);
  const existingPolicy = await getObjectAclPolicy(objectFile);
  if (existingPolicy && existingPolicy.owner !== String(ownerId)) {
    throw new ObjectOwnershipConflictError();
  }
  await setObjectAclPolicy(objectFile, { owner: String(ownerId), visibility: "private" });
}

class ObjectOwnershipConflictError extends Error {
  constructor() {
    super("Object is already owned by another user");
    this.name = "ObjectOwnershipConflictError";
  }
}

async function serializeGame(gameId: number, ownerId: number) {
  const game = await db.query.gamesTable.findFirst({
    where: and(eq(gamesTable.id, gameId), eq(gamesTable.ownerId, ownerId)),
  });
  if (!game) return null;

  const team = await db.query.teamsTable.findFirst({
    where: and(eq(teamsTable.id, game.teamId), eq(teamsTable.ownerId, ownerId)),
  });

  const statRows = await db
    .select({ stat: playerGameStatsTable, playerName: playersTable.name })
    .from(playerGameStatsTable)
    .innerJoin(
      playersTable,
      and(eq(playerGameStatsTable.playerId, playersTable.id), eq(playersTable.ownerId, ownerId)),
    )
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
  const ownerId = req.appUser!.id;

  const team = await db.query.teamsTable.findFirst({
    where: and(eq(teamsTable.id, body.teamId), eq(teamsTable.ownerId, ownerId)),
  });
  if (!team) {
    res.status(404).json({ error: "Team not found" });
    return;
  }

  const referencedPlayerIds = [
    ...body.stats.map((s) => s.playerId),
    ...body.events.map((e) => e.playerId),
  ];
  if (!(await assertPlayersOwned(referencedPlayerIds, ownerId))) {
    res.status(404).json({ error: "Player not found" });
    return;
  }

  if (body.videoObjectPath) {
    const entitlements = await getEntitlements(req.appUser!.stripeCustomerId);
    if (entitlements.plan !== "pro") {
      res.status(403).json({
        error: "Saved game video is a Pro feature. Upgrade to Pro to save video with your games.",
        code: "UPGRADE_REQUIRED",
      });
      return;
    }
  }

  const videoObjectPath = body.videoObjectPath
    ? objectStorageService.normalizeObjectEntityPath(body.videoObjectPath)
    : null;

  if (videoObjectPath) {
    try {
      await claimVideoObjectPath(videoObjectPath, ownerId);
    } catch (err) {
      if (err instanceof ObjectOwnershipConflictError) {
        res.status(409).json({ error: "Video object is already owned by another user" });
        return;
      }
      req.log.error({ err }, "Failed to claim video object ACL policy");
      res.status(400).json({ error: "Invalid or inaccessible video object" });
      return;
    }
  }

  const game = await db.transaction(async (tx) => {
    const [createdGame] = await tx
      .insert(gamesTable)
      .values({
        teamId: body.teamId,
        ownerId,
        opponent: body.opponent,
        date: body.date.toISOString().slice(0, 10),
        result: body.result,
        teamScore: body.teamScore,
        opponentScore: body.opponentScore,
        videoObjectPath,
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

  const serialized = await serializeGame(game.id, ownerId);
  res.status(201).json(CreateGameResponse.parse(serialized));
});

router.get("/games/:gameId", requireAuth, async (req, res) => {
  const { gameId } = GetGameParams.parse(req.params);
  const serialized = await serializeGame(gameId, req.appUser!.id);
  if (!serialized) {
    res.status(404).json({ error: "Game not found" });
    return;
  }
  res.json(GetGameResponse.parse(serialized));
});

router.patch("/games/:gameId", requireAuth, async (req, res) => {
  const { gameId } = UpdateGameParams.parse(req.params);
  const body = UpdateGameBody.parse(req.body);
  const ownerId = req.appUser!.id;

  const existing = await db.query.gamesTable.findFirst({
    where: and(eq(gamesTable.id, gameId), eq(gamesTable.ownerId, ownerId)),
  });
  if (!existing) {
    res.status(404).json({ error: "Game not found" });
    return;
  }

  const team = await db.query.teamsTable.findFirst({
    where: and(eq(teamsTable.id, body.teamId), eq(teamsTable.ownerId, ownerId)),
  });
  if (!team) {
    res.status(404).json({ error: "Team not found" });
    return;
  }

  const referencedPlayerIds = [
    ...body.stats.map((s) => s.playerId),
    ...body.events.map((e) => e.playerId),
  ];
  if (!(await assertPlayersOwned(referencedPlayerIds, ownerId))) {
    res.status(404).json({ error: "Player not found" });
    return;
  }

  if (body.videoObjectPath && body.videoObjectPath !== existing.videoObjectPath) {
    const entitlements = await getEntitlements(req.appUser!.stripeCustomerId);
    if (entitlements.plan !== "pro") {
      res.status(403).json({
        error: "Saved game video is a Pro feature. Upgrade to Pro to save video with your games.",
        code: "UPGRADE_REQUIRED",
      });
      return;
    }
  }

  const videoObjectPath = body.videoObjectPath
    ? objectStorageService.normalizeObjectEntityPath(body.videoObjectPath)
    : null;

  if (videoObjectPath && videoObjectPath !== existing.videoObjectPath) {
    try {
      await claimVideoObjectPath(videoObjectPath, ownerId);
    } catch (err) {
      if (err instanceof ObjectOwnershipConflictError) {
        res.status(409).json({ error: "Video object is already owned by another user" });
        return;
      }
      req.log.error({ err }, "Failed to claim video object ACL policy");
      res.status(400).json({ error: "Invalid or inaccessible video object" });
      return;
    }
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
        videoObjectPath,
        // Editing stats/events/video invalidates any existing highlight reel.
        highlightObjectPath: null,
        highlightStatus: "idle",
        highlightError: null,
        highlightStartedAt: null,
      })
      .where(and(eq(gamesTable.id, gameId), eq(gamesTable.ownerId, ownerId)));

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

  const serialized = await serializeGame(gameId, ownerId);
  res.json(UpdateGameResponse.parse(serialized));
});

router.delete("/games/:gameId", requireAuth, async (req, res) => {
  const { gameId } = DeleteGameParams.parse(req.params);
  await db
    .delete(gamesTable)
    .where(and(eq(gamesTable.id, gameId), eq(gamesTable.ownerId, req.appUser!.id)));
  res.status(204).send();
});

export default router;
