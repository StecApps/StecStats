import { Router, type IRouter } from "express";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { execFile, spawn } from "child_process";
import { promises as fs, createWriteStream, createReadStream } from "fs";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
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
import { type File as GCSFile } from "@google-cloud/storage";
import { computePoints } from "../lib/stats";
import { ObjectStorageService } from "../lib/objectStorage";
import { getObjectAclPolicy, setObjectAclPolicy, ObjectPermission } from "../lib/objectAcl";
import { requireAuth } from "../middlewares/requireAuth";
import { getEntitlements, isPro } from "../lib/entitlements";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

interface SegmentBoundary {
  /** Byte offset where the second segment starts (inside the combined file). */
  splitOffset: number;
  /** True when seg2 has no leading ftyp box; we must prepend ftypData before ffmpeg. */
  needsFtypPrepend: boolean;
  /** Raw bytes of the first ftyp box to prepend when needed. */
  ftypData: Buffer;
}

/**
 * Read exactly `length` bytes starting at `offset` from a GCS file using the
 * SDK's authenticated createReadStream — bypasses signed URLs entirely so
 * range requests are always reliable regardless of sidecar URL quirks.
 * Returns null if we're past the end of the file.
 */
async function readGCSBytes(file: GCSFile, offset: number, length: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const stream = file.createReadStream({ start: offset, end: offset + length - 1 });
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(chunks.length > 0 ? Buffer.concat(chunks) : null));
    stream.on("error", () => resolve(null));
  });
}

/**
 * Scan the top-level MP4 box structure via authenticated GCS range reads and
 * detect where a second raw-concatenated segment begins.
 *
 * Two common layouts produced by client-side Blob.concat on iOS recordings:
 *   A) [ftyp1][mdat1][moov1][ftyp2][mdat2][moov2]  – second ftyp present
 *   B) [ftyp][mdat1][moov1][mdat2][moov2]           – shared ftyp, no second ftyp
 *
 * In layout B we prepend a copy of seg1's ftyp to seg2 before handing it to
 * ffmpeg so it has a valid MP4 container header.
 *
 * Returns null when no second segment is detected (single-segment file).
 */
async function detectSegmentBoundary(file: GCSFile, log: any): Promise<SegmentBoundary | null> {
  let offset = 0;
  let seenMoov = false;
  let seenMdatBeforeMoov = false;
  let ftypData: Buffer | null = null;

  for (let iter = 0; iter < 60; iter++) {
    const buf = await readGCSBytes(file, offset, 16);
    if (!buf || buf.length < 8) break;

    const sizeField = buf.readUInt32BE(0);
    const boxType = buf.slice(4, 8).toString("ascii").replace(/[^\x20-\x7e]/g, "?");
    let boxSize: number;
    if (sizeField === 1 && buf.length >= 16) {
      boxSize = buf.readUInt32BE(8) * 4294967296 + buf.readUInt32BE(12);
    } else if (sizeField === 0 || sizeField < 8) {
      break;
    } else {
      boxSize = sizeField;
    }

    log.info({ iter, offset, boxType, boxSize }, "repair-video: box scan");

    if (seenMoov) {
      if (!seenMdatBeforeMoov && boxType === "mdat") {
        offset += boxSize;
        continue;
      }
      return {
        splitOffset: offset,
        needsFtypPrepend: boxType !== "ftyp",
        ftypData: ftypData ?? Buffer.alloc(0),
      };
    }

    if (boxType === "ftyp" && !ftypData) {
      const ftypBuf = await readGCSBytes(file, offset, boxSize);
      if (ftypBuf) {
        ftypData = ftypBuf;
        log.info({ ftypSize: ftypData.length }, "repair-video: captured ftyp");
      }
    }

    if (boxType === "mdat" && !seenMoov) seenMdatBeforeMoov = true;
    if (boxType === "moov") seenMoov = true;
    offset += boxSize;
  }

  return null;
}

/**
 * Scan a WebM/Matroska file for a second EBML header, indicating the file is a
 * raw concatenation of two recording sessions (e.g. "Start 2nd Half" on Chrome/
 * Android where MediaRecorder produces WebM). Returns the byte offset of the
 * second EBML element, or null if the file is a single segment.
 *
 * EBML header signature: 1A 45 DF A3
 * Verified by checking that "webm" or "matroska" appears within the next 120
 * bytes (the DocType string that follows every EBML header).
 */
/**
 * Scan a LOCAL file (already downloaded to disk) for the byte offset of a
 * second EBML header — the signature of a raw-concatenated two-half WebM.
 * Uses fs.read so there are no GCS range-read reliability concerns.
 */
async function detectWebMSplitOffsetLocal(filePath: string, log: any): Promise<number | null> {
  const EBML_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
  const CHUNK = 16 * 1024 * 1024;
  const MIN_START = 50 * 1024 * 1024;

  const stat = await fs.stat(filePath);
  const fileSize = stat.size;
  const fh = await fs.open(filePath, "r");
  try {
    for (let offset = MIN_START; offset < fileSize; offset += CHUNK) {
      const length = Math.min(CHUNK + 4, fileSize - offset);
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, offset);
      if (bytesRead < 4) break;
      const slice = buf.subarray(0, bytesRead);

      let pos = 0;
      while (pos <= slice.length - 4) {
        const idx = slice.indexOf(EBML_MAGIC, pos);
        if (idx === -1) break;
        const candidateOffset = offset + idx;
        const verifySlice = slice.slice(idx, Math.min(slice.length, idx + 120));
        const verifyStr = verifySlice.toString("binary");
        if (verifyStr.includes("webm") || verifyStr.includes("matroska")) {
          log.info({ candidateOffset }, "repair-video: found second EBML header (WebM two-half split)");
          return candidateOffset;
        }
        pos = idx + 1;
      }
    }
  } finally {
    await fh.close();
  }
  return null;
}

/**
 * Stream a byte range (or the full tail from start) from a GCS file to disk
 * using the SDK's authenticated stream — no signed URL needed.
 */
async function downloadGCSRange(
  file: GCSFile,
  destPath: string,
  start?: number,
  end?: number,
  prependData?: Buffer,
): Promise<void> {
  const ws = createWriteStream(destPath);
  if (prependData && prependData.length > 0) {
    await new Promise<void>((resolve, reject) =>
      ws.write(prependData, (err) => (err ? reject(err) : resolve())),
    );
  }
  const opts: { start?: number; end?: number } = {};
  if (start !== undefined) opts.start = start;
  if (end !== undefined) opts.end = end;
  await pipeline(file.createReadStream(opts), ws);
}

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
    videoOffsetMs: game.videoOffsetMs ?? null,
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
      goals: stat.goals,
      shots: stat.shots,
      shotsOffTarget: stat.shotsOffTarget,
      saves: stat.saves,
      yellowCards: stat.yellowCards,
      redCards: stat.redCards,
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
        videoOffsetMs: body.videoOffsetMs ?? null,
        // Only invalidate the reels when the video file itself changes.
        // If the video is unchanged, the clips are still valid.
        ...(videoObjectPath !== existing.videoObjectPath
          ? {
              highlightObjectPath: null,
              highlightStatus: "idle",
              highlightError: null,
              highlightStartedAt: null,
              lowlightObjectPath: null,
              lowlightStatus: "idle",
              lowlightError: null,
              lowlightStartedAt: null,
            }
          : {}),
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

  // Read the stored content-type so we can force it on the signed URL via
  // response-content-type. Without this, objects stored as
  // application/octet-stream (can happen when blob.type is empty on some
  // devices) cause the browser to download the file instead of playing it.
  const objectFile = await objectStorageService.getObjectEntityFile(game.videoObjectPath);
  const [metadata] = await objectFile.getMetadata();
  const storedType = (metadata.contentType as string) || "";
  const contentType = storedType.startsWith("video/") ? storedType : "video/mp4";

  let url = await objectStorageService.getObjectEntitySignedURL(game.videoObjectPath, 3600);
  const sep = url.includes("?") ? "&" : "?";
  url += `${sep}response-content-type=${encodeURIComponent(contentType)}`;

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
/**
 * PATCH /games/:gameId/video
 *
 * Lightweight endpoint for attaching an already-uploaded video object to an
 * existing game. Used by the background-upload flow so the game record and
 * stats are saved immediately (without waiting for the upload to finish) and
 * the video is linked once the upload completes.
 *
 * Resets highlight/lowlight status to idle so the client can trigger
 * generation after the video is confirmed attached.
 */
router.patch("/games/:gameId/video", requireAuth, async (req, res) => {
  const gameId = Number(req.params.gameId);
  if (isNaN(gameId)) return void res.status(400).json({ error: "Invalid gameId" });

  const rawPath = req.body?.videoObjectPath;
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    return void res.status(400).json({ error: "videoObjectPath is required" });
  }

  const ownerId = req.appUser!.id;
  const game = await db.query.gamesTable.findFirst({
    where: and(eq(gamesTable.id, gameId), eq(gamesTable.ownerId, ownerId)),
  });
  if (!game) return void res.status(404).json({ error: "Game not found" });

  const entitlements = await getEntitlements(req.appUser!.stripeCustomerId, req.appUser!.email);
  if (!isPro(entitlements)) {
    return void res.status(403).json({
      error: "Saved game video is a Pro feature. Upgrade to Pro to save video with your games.",
      code: "UPGRADE_REQUIRED",
    });
  }

  const videoObjectPath = objectStorageService.normalizeObjectEntityPath(rawPath);

  if (videoObjectPath !== game.videoObjectPath) {
    try {
      await claimVideoObjectPath(videoObjectPath, ownerId);
    } catch (err) {
      if (err instanceof ObjectOwnershipConflictError) {
        return void res.status(409).json({ error: "Video object is already owned by another user" });
      }
      req.log.error({ err }, "Failed to claim video object ACL policy");
      return void res.status(400).json({ error: "Invalid or inaccessible video object" });
    }
  }

  await db
    .update(gamesTable)
    .set({
      videoObjectPath,
      highlightObjectPath: null,
      highlightStatus: "idle",
      highlightError: null,
      highlightStartedAt: null,
      lowlightObjectPath: null,
      lowlightStatus: "idle",
      lowlightError: null,
      lowlightStartedAt: null,
    })
    .where(and(eq(gamesTable.id, gameId), eq(gamesTable.ownerId, ownerId)));

  req.log.info({ gameId, videoObjectPath }, "game video attached via background upload");
  res.json({ ok: true });
});

router.post("/games/:gameId/repair-video", requireAuth, async (req, res) => {
  const gameId = Number(req.params.gameId);
  if (isNaN(gameId)) return void res.status(400).json({ error: "Invalid gameId" });

  const ownerId = req.appUser!.id;
  const game = await db.query.gamesTable.findFirst({
    where: and(eq(gamesTable.id, gameId), eq(gamesTable.ownerId, ownerId)),
  });
  if (!game) return void res.status(404).json({ error: "Game not found" });
  if (!game.videoObjectPath) return void res.status(400).json({ error: "Game has no video" });

  // Allow re-repair from the original source (e.g. the raw-concatenated file
  // before a previous single-segment repair extracted the wrong half).
  let sourceObjectPath = game.videoObjectPath;
  const bodySource = typeof req.body?.sourceObjectPath === "string" ? req.body.sourceObjectPath.trim() : null;
  if (bodySource) {
    if (!bodySource.startsWith("/objects/")) {
      return void res.status(400).json({ error: "Invalid sourceObjectPath" });
    }
    try {
      const srcFile = await objectStorageService.getObjectEntityFile(bodySource);
      const ok = await objectStorageService.canAccessObjectEntity({
        userId: String(ownerId),
        objectFile: srcFile,
        requestedPermission: ObjectPermission.READ,
      });
      if (!ok) return void res.status(403).json({ error: "No access to source file" });
      sourceObjectPath = bodySource;
    } catch {
      return void res.status(404).json({ error: "Source file not found" });
    }
  }

  // Quality preference — '720p' transcodes to 720p (smaller, faster highlights);
  // anything else keeps the original codec/resolution via -c copy.
  const repairQuality = req.body?.quality === '720p' ? '720p' : 'original';

  // Kick off the repair asynchronously so we can return 202 immediately.
  // For large files (2-3 GB) the download + ffmpeg + re-upload takes several
  // minutes, far exceeding any HTTP proxy timeout.  The client should poll
  // the game record until videoObjectPath changes (or just refresh the page).
  const log = req.log;
  res.status(202).json({ status: "started", message: "Repair running in the background — refresh this page in a few minutes." });

  (async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `repair-${gameId}-`));
  try {
    // Get the GCS File object — used for authenticated SDK reads/downloads,
    // bypassing signed URLs (which have unreliable range-request support in
    // the Replit production sidecar environment).
    log.info({ gameId, sourceObjectPath }, "repair-video: opening source file");
    const srcFile = await objectStorageService.getObjectEntityFile(sourceObjectPath);

    // Diagnostic probe: log GCS metadata, hex dump of first 64 bytes, and
    // ffprobe output from the first 8 MB so we know the exact file format
    // without guessing from box-type bytes alone.
    let srcFileSize = 0;
    let srcContentType = "";
    try {
      const [meta] = await (srcFile as any).getMetadata();
      srcFileSize = Number(meta.size) || 0;
      srcContentType = String(meta.contentType || "");
      log.info(
        { size: meta.size, contentType: meta.contentType, contentEncoding: meta.contentEncoding ?? null },
        "repair-video: source metadata",
      );

      const firstBytes = await readGCSBytes(srcFile, 0, 64);
      if (firstBytes) {
        log.info({ hex: firstBytes.toString("hex") }, "repair-video: source hex dump");
      }

      const probePath = path.join(tmpDir, "probe.bin");
      await downloadGCSRange(srcFile, probePath, 0, 8 * 1024 * 1024 - 1);
      await new Promise<void>((resolve) => {
        execFile(
          "ffprobe",
          ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", probePath],
          { maxBuffer: 2 * 1024 * 1024 },
          (_err, stdout, stderr) => {
            try {
              const parsed = JSON.parse(stdout || "{}");
              log.info(
                {
                  format: parsed.format?.format_name,
                  duration: parsed.format?.duration,
                  size: parsed.format?.size,
                  streams: (parsed.streams ?? []).map((s: any) => ({
                    codec: s.codec_name,
                    type: s.codec_type,
                    duration: s.duration,
                  })),
                  ffprobeErr: stderr?.slice(0, 300) || null,
                },
                "repair-video: ffprobe result",
              );
            } catch {
              log.info({ raw: stdout?.slice(0, 500), err: stderr?.slice(0, 300) }, "repair-video: ffprobe raw");
            }
            resolve();
          },
        );
      });
    } catch (diagErr: any) {
      log.warn({ msg: String(diagErr?.message ?? diagErr) }, "repair-video: diagnostic failed");
    }

    // Scan the top-level box structure to detect whether the file contains
    // two raw-concatenated segments.  Handles both layouts:
    //   A) [ftyp1][mdat1][moov1][ftyp2][mdat2][moov2]  – second ftyp present
    //   B) [ftyp][mdat1][moov1][mdat2][moov2]           – shared ftyp, no second ftyp
    log.info({ gameId }, "repair-video: scanning for segment boundary");
    const boundary = await detectSegmentBoundary(srcFile, log);
    log.info(
      { gameId, splitOffset: boundary?.splitOffset ?? null, needsFtypPrepend: boundary?.needsFtypPrepend ?? null },
      "repair-video: scan complete",
    );

    // Encode args for each segment remux.  720p transcodes to H.264/AAC at 720p;
    // 'original' keeps the existing codec stream via -c copy.
    // The final concat step always uses -c copy (streams are already at target res).
    const ffmpegEncodeArgs: string[] = repairQuality === '720p'
      ? ["-vf", "scale=-2:720", "-c:v", "libx264", "-crf", "23", "-preset", "veryfast", "-c:a", "aac", "-movflags", "+faststart"]
      : ["-c", "copy", "-movflags", "+faststart"];
    // Set by the WebM two-half path; stored to DB for highlight timestamp correction.
    let videoHalf2StartMs: number | null = null;
    let videoHalftimeGapMs: number | null = null;

    const tmpOut = path.join(tmpDir, "final.mp4");

    if (boundary) {
      // Two-segment path (MP4): download each half as a standalone MP4
      // (prepending the shared ftyp to seg2 when the layout has no second
      // ftyp box), faststart-remux each half, then concat-demux.
      const raw0 = path.join(tmpDir, "raw0.mp4");
      const raw1 = path.join(tmpDir, "raw1.mp4");

      log.info({ gameId, end: boundary.splitOffset - 1 }, "repair-video: downloading seg1");
      await downloadGCSRange(srcFile, raw0, 0, boundary.splitOffset - 1);

      log.info(
        { gameId, start: boundary.splitOffset, needsFtypPrepend: boundary.needsFtypPrepend },
        "repair-video: downloading seg2",
      );
      await downloadGCSRange(
        srcFile,
        raw1,
        boundary.splitOffset,
        undefined,
        boundary.needsFtypPrepend ? boundary.ftypData : undefined,
      );

      const procPaths: string[] = [];
      for (let i = 0; i < 2; i++) {
        const rawSeg = i === 0 ? raw0 : raw1;
        const procSeg = path.join(tmpDir, `proc${i}.mp4`);
        log.info({ gameId, i }, "repair-video: ffmpeg on segment");
        await new Promise<void>((resolve, reject) => {
          execFile(
            "ffmpeg",
            ["-y", "-i", rawSeg, ...ffmpegEncodeArgs, procSeg],
            { maxBuffer: 5 * 1024 * 1024 },
            (err, _stdout, stderr) =>
              err ? reject(new Error(`ffmpeg seg${i}: ${stderr?.slice(-500)}`)) : resolve(),
          );
        });
        await fs.unlink(rawSeg).catch(() => {});
        procPaths.push(procSeg);
      }

      // Concat: adjusts timestamps so seg2 follows seg1 seamlessly
      const fileList = path.join(tmpDir, "filelist.txt");
      await fs.writeFile(fileList, procPaths.map((p) => `file '${p}'`).join("\n"), "utf8");
      log.info({ gameId }, "repair-video: concatenating 2 segments");
      await new Promise<void>((resolve, reject) => {
        const proc = spawn("ffmpeg", [
          "-f", "concat", "-safe", "0",
          "-protocol_whitelist", "file,http,https,tcp,tls,crypto",
          "-i", fileList,
          "-c", "copy", "-movflags", "+faststart",
          "-y", tmpOut,
        ]);
        let stderr = "";
        proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
        proc.on("close", (code) =>
          code === 0 ? resolve() : reject(new Error(`ffmpeg concat: ${stderr.slice(-500)}`)));
        proc.on("error", reject);
      });
    } else {
      // Non-MP4 or single-segment path.
      // Download the full source file to disk first. For WebM files we then
      // scan it locally for a two-half EBML split (GCS range reads are
      // unreliable after the diagnostic probe has already used the file handle).
      const isWebM = srcContentType.includes("webm");
      const rawExt = isWebM ? "webm" : "bin";
      const rawFull = path.join(tmpDir, `raw.${rawExt}`);
      log.info({ gameId, isWebM }, "repair-video: downloading full source file");
      await downloadGCSRange(srcFile, rawFull);

      if (isWebM) {
        log.info({ gameId }, "repair-video: scanning local WebM file for two-half split");
        const splitOffset = await detectWebMSplitOffsetLocal(rawFull, log);
        log.info({ gameId, splitOffset }, "repair-video: local WebM split scan complete");

        if (splitOffset !== null) {
          // Split the local file into two raw WebM halves, remux each to MP4,
          // then ffmpeg-concat so the second half's timestamps follow the first.
          const raw0 = path.join(tmpDir, "raw0.webm");
          const raw1 = path.join(tmpDir, "raw1.webm");

          log.info({ gameId, splitOffset }, "repair-video: splitting WebM into two halves");

          // Use streaming reads so we never allocate GB-sized Buffers
          await pipeline(createReadStream(rawFull, { start: 0, end: splitOffset - 1 }), createWriteStream(raw0));
          await pipeline(createReadStream(rawFull, { start: splitOffset }), createWriteStream(raw1));
          await fs.unlink(rawFull).catch(() => {});

          const procPaths: string[] = [];
          for (let i = 0; i < 2; i++) {
            const rawSeg = i === 0 ? raw0 : raw1;
            const procSeg = path.join(tmpDir, `proc${i}.mp4`);
            log.info({ gameId, i }, "repair-video: ffmpeg on WebM segment");
            await new Promise<void>((resolve, reject) => {
              execFile(
                "ffmpeg",
                ["-y", "-i", rawSeg, ...ffmpegEncodeArgs, procSeg],
                { maxBuffer: 5 * 1024 * 1024 },
                (err, _stdout, stderr) =>
                  err ? reject(new Error(`ffmpeg webm-seg${i}: ${stderr?.slice(-500)}`)) : resolve(),
              );
            });
            await fs.unlink(rawSeg).catch(() => {});
            procPaths.push(procSeg);
          }

          // Probe proc0 duration and query the first second-half event so we
          // can store the halftime gap.  This lets the highlight generator
          // subtract the gap from second-half event timestamps, mapping them
          // to the correct position in the stitched two-half video.
          try {
            const proc0DurStr = await new Promise<string>((resolve, reject) => {
              execFile(
                "ffprobe",
                ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", procPaths[0]],
                { maxBuffer: 1024 * 1024 },
                (err, stdout) => err ? reject(err) : resolve(stdout.trim()),
              );
            });
            const proc0DurMs = Math.round(parseFloat(proc0DurStr) * 1000);
            if (proc0DurMs > 0) {
              const [firstHalf2Event] = await db
                .select({ ts: gameEventsTable.videoTimestampMs })
                .from(gameEventsTable)
                .where(and(
                  eq(gameEventsTable.gameId, gameId),
                  gt(gameEventsTable.videoTimestampMs, proc0DurMs + 5000),
                ))
                .orderBy(asc(gameEventsTable.videoTimestampMs))
                .limit(1);
              if (firstHalf2Event) {
                const gap = firstHalf2Event.ts - proc0DurMs;
                if (gap > 5000) {
                  videoHalf2StartMs = firstHalf2Event.ts;
                  videoHalftimeGapMs = gap;
                  log.info(
                    { proc0DurMs, videoHalf2StartMs, videoHalftimeGapMs },
                    "repair-video: halftime gap computed",
                  );
                }
              }
            }
          } catch (halfErr) {
            log.warn({ err: String(halfErr) }, "repair-video: halftime gap computation failed (non-fatal)");
          }

          const fileList = path.join(tmpDir, "filelist.txt");
          await fs.writeFile(fileList, procPaths.map((p) => `file '${p}'`).join("\n"), "utf8");
          log.info({ gameId }, "repair-video: concatenating WebM 2 segments");
          await new Promise<void>((resolve, reject) => {
            const proc = spawn("ffmpeg", [
              "-f", "concat", "-safe", "0",
              "-protocol_whitelist", "file,http,https,tcp,tls,crypto",
              "-i", fileList,
              "-c", "copy", "-movflags", "+faststart",
              "-y", tmpOut,
            ]);
            let stderr = "";
            proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
            proc.on("close", (code) =>
              code === 0 ? resolve() : reject(new Error(`ffmpeg webm-concat: ${stderr.slice(-500)}`)));
            proc.on("error", reject);
          });
        } else {
          // Single WebM segment — just faststart-remux the whole thing
          log.info({ gameId }, "repair-video: single WebM segment, applying faststart");
          await new Promise<void>((resolve, reject) => {
            execFile(
              "ffmpeg",
              ["-y", "-i", rawFull, ...ffmpegEncodeArgs, tmpOut],
              { maxBuffer: 5 * 1024 * 1024 },
              (err, _stdout, stderr) =>
                err ? reject(new Error(`ffmpeg webm-faststart: ${stderr?.slice(-600)}`)) : resolve(),
            );
          });
        }
      } else {
        // Non-WebM single segment: faststart remux
        log.info({ gameId }, "repair-video: applying faststart");
        await new Promise<void>((resolve, reject) => {
          execFile(
            "ffmpeg",
            ["-y", "-i", rawFull, ...ffmpegEncodeArgs, tmpOut],
            { maxBuffer: 5 * 1024 * 1024 },
            (err, _stdout, stderr) =>
              err ? reject(new Error(`ffmpeg: ${stderr?.slice(-600)}`)) : resolve(),
          );
        });
      }
    }

    log.info({ gameId }, "repair-video: uploading");
    const newObjectPath = await objectStorageService.uploadLocalFileAsObjectEntity(
      tmpOut,
      ownerId,
      "video/mp4",
    );

    await db
      .update(gamesTable)
      .set({
        videoObjectPath: newObjectPath,
        videoProxyObjectPath: null,       // force proxy rebuild from repaired video
        highlightStatus: "idle",
        highlightObjectPath: null,
        lowlightStatus: "idle",
        lowlightObjectPath: null,
        videoHalf2StartMs,
        videoHalftimeGapMs,
      })
      .where(eq(gamesTable.id, gameId));

    log.info({ gameId, newObjectPath }, "repair-video: done");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
  })().catch((err) => {
    log.error({ gameId, err: String(err?.message ?? err) }, "repair-video: background job failed");
  });
});

export default router;
