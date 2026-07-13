import { Router, type IRouter } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { execFile } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
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
import { getEntitlements, isPro } from "../lib/entitlements";

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
    const entitlements = await getEntitlements(req.appUser!.stripeCustomerId, req.appUser!.email);
    if (!isPro(entitlements)) {
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
    const entitlements = await getEntitlements(req.appUser!.stripeCustomerId, req.appUser!.email);
    if (!isPro(entitlements)) {
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

/**
 * GET /games/:gameId/video-signed-url
 * Returns a short-lived signed URL for the game video so the browser can
 * play it directly from GCS — no server-side proxy needed.
 */
router.get("/games/:gameId/video-signed-url", requireAuth, async (req, res) => {
  const gameId = Number(req.params.gameId);
  if (isNaN(gameId)) return void res.status(400).json({ error: "Invalid gameId" });
  const ownerId = req.appUser!.id;
  const game = await db.query.gamesTable.findFirst({
    where: and(eq(gamesTable.id, gameId), eq(gamesTable.ownerId, ownerId)),
  });
  if (!game?.videoObjectPath) return void res.status(404).json({ error: "No video" });
  const url = await objectStorageService.getObjectEntitySignedURL(game.videoObjectPath, 3600);
  res.json({ url, expiresAt: Date.now() + 3600 * 1000 });
});

/**
 * GET /games/:gameId/video-probe — run ffprobe on the game video and return
 * codec/format info so we can diagnose playback issues without downloading.
 */
router.get("/games/:gameId/video-probe", requireAuth, async (req, res) => {
  const gameId = Number(req.params.gameId);
  if (isNaN(gameId)) return void res.status(400).json({ error: "Invalid gameId" });
  const ownerId = req.appUser!.id;
  const game = await db.query.gamesTable.findFirst({
    where: and(eq(gamesTable.id, gameId), eq(gamesTable.ownerId, ownerId)),
  });
  if (!game?.videoObjectPath) return void res.status(404).json({ error: "No video" });

  const srcUrl = await objectStorageService.getObjectEntitySignedURL(game.videoObjectPath, 3600);
  await new Promise<void>((resolve, reject) => {
    execFile(
      "ffprobe",
      ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", srcUrl],
      { maxBuffer: 5 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) { reject(new Error(stderr.slice(-500))); return; }
        try {
          const data = JSON.parse(stdout);
          res.json({
            format: data.format?.format_name,
            duration: data.format?.duration,
            size: data.format?.size,
            streams: data.streams?.map((s: Record<string, unknown>) => ({
              type: s.codec_type, codec: s.codec_name,
              width: s.width, height: s.height,
            })),
          });
        } catch { res.json({ raw: stdout.slice(0, 2000) }); }
        resolve();
      },
    );
  });
});

/**
 * POST /games/:gameId/repair-video
 *
 * Re-mux a game's recorded video through ffmpeg with -movflags +faststart so
 * the moov atom lands at the front of the file.  This fixes videos that were
 * raw-concatenated from multiple segments (broken MP4 container) and videos
 * where the moov atom is at the end (causes Chrome to fail to play without
 * multiple round-trip range requests).  A new object is uploaded and the game
 * record is updated in-place; the old object is left untouched.
 */
router.post("/games/:gameId/repair-video", requireAuth, async (req, res) => {
  const gameId = Number(req.params.gameId);
  if (isNaN(gameId)) return void res.status(400).json({ error: "Invalid gameId" });

  const ownerId = req.appUser!.id;
  const game = await db.query.gamesTable.findFirst({
    where: and(eq(gamesTable.id, gameId), eq(gamesTable.ownerId, ownerId)),
  });

  if (!game) return void res.status(404).json({ error: "Game not found" });
  if (!game.videoObjectPath) return void res.status(400).json({ error: "Game has no video" });

  const tmpOut = path.join(os.tmpdir(), `repair-out-${gameId}-${Date.now()}.mp4`);

  try {
    // Use a signed URL so ffmpeg reads directly from GCS via HTTP range
    // requests — no full download needed, much faster and won't time out.
    req.log.info({ gameId, objectPath: game.videoObjectPath }, "repair-video: signing URL");
    const srcUrl = await objectStorageService.getObjectEntitySignedURL(
      game.videoObjectPath,
      3 * 3600,
    );

    req.log.info({ gameId }, "repair-video: running ffmpeg (faststart remux)");
    await new Promise<void>((resolve, reject) => {
      execFile(
        "ffmpeg",
        ["-y", "-i", srcUrl, "-c", "copy", "-movflags", "+faststart", tmpOut],
        { maxBuffer: 10 * 1024 * 1024 },
        (err, _stdout, stderr) => {
          if (err) {
            reject(new Error(`ffmpeg error: ${stderr?.slice(-800)}`));
          } else {
            resolve();
          }
        },
      );
    });

    req.log.info({ gameId, tmpOut }, "repair-video: uploading repaired file");
    const newObjectPath = await objectStorageService.uploadLocalFileAsObjectEntity(
      tmpOut,
      ownerId,
      "video/mp4",
    );

    await db
      .update(gamesTable)
      .set({
        videoObjectPath: newObjectPath,
        highlightStatus: "idle",
        highlightObjectPath: null,
        lowlightStatus: "idle",
        lowlightObjectPath: null,
      })
      .where(eq(gamesTable.id, gameId));

    req.log.info({ gameId, newObjectPath }, "repair-video: done");
    res.json({ success: true, newObjectPath });
  } finally {
    await fs.unlink(tmpOut).catch(() => {});
  }
});

export default router;
