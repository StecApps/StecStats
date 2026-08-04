import { Router, type IRouter } from "express";
import { and, asc, eq, gt, inArray, isNull } from "drizzle-orm";
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
  MergeGamesBody,
  MergeGamesResponse,
} from "@workspace/api-zod";
import { type File as GCSFile } from "@google-cloud/storage";
import { computePoints } from "../lib/stats";
import { ObjectStorageService } from "../lib/objectStorage";
import { getObjectAclPolicy, setObjectAclPolicy, ObjectPermission } from "../lib/objectAcl";
import { requireAuth } from "../middlewares/requireAuth";
import { getEntitlementsForUser, getEntitlements, isPro } from "../lib/entitlements";
import { scheduleVideoDurationProbe } from "../lib/videoDuration";
import { PROXY_VERSION, ensureGameProxyInBackground, cancelHighlightGeneration, cancelProxyBuild } from "../lib/highlightGenerator";

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
 * GCS-streaming version of the WebM split detector.  Reads 16 MB chunks
 * directly from GCS via authenticated createReadStream calls — no full-file
 * download required.  Uses the same verification logic as the local scanner.
 */
async function detectWebMSplitOffsetGCS(
  file: GCSFile,
  fileSize: number,
  log: any,
): Promise<number | null> {
  const EBML_MAGIC    = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
  const SEGMENT_ID    = Buffer.from([0x18, 0x53, 0x80, 0x67]);
  // 64 MB chunks → ~33 reads for a 2.3 GB file (vs 134 with 16 MB).
  // Fewer HTTP connections = much faster and less chance of a hanging read.
  const CHUNK         = 64 * 1024 * 1024;
  const VERIFY_WINDOW = 300;
  const MIN_START     = 50 * 1024 * 1024;
  // Per-chunk timeout: GCS createReadStream can hang indefinitely if the
  // underlying HTTP connection stalls with no error event.
  const READ_TIMEOUT_MS = 90_000;

  let candidatesFound = 0;
  let chunkIdx = 0;
  for (let offset = MIN_START; offset < fileSize; offset += CHUNK) {
    const length = Math.min(CHUNK + VERIFY_WINDOW, fileSize - offset);

    // Race the GCS read against a hard timeout so a hung stream doesn't
    // stall the repair forever.
    const slice = await Promise.race<Buffer | null>([
      readGCSBytes(file, offset, length),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), READ_TIMEOUT_MS)),
    ]);

    if (!slice || slice.length < 4) {
      log.warn(
        { chunkIdx, offset, fileSize },
        "repair-video: GCS scan chunk timed out or returned no data — aborting",
      );
      break;
    }

    if (chunkIdx % 5 === 0) {
      log.info(
        { chunkIdx, offsetMB: Math.round(offset / 1024 / 1024), fileSizeMB: Math.round(fileSize / 1024 / 1024) },
        "repair-video: GCS scan progress",
      );
    }
    chunkIdx++;

    let pos = 0;
    while (pos <= slice.length - 4) {
      const idx = slice.indexOf(EBML_MAGIC, pos);
      if (idx === -1) break;
      candidatesFound++;
      const candidateOffset = offset + idx;

      const verifyEnd = Math.min(slice.length, idx + VERIFY_WINDOW);
      const verifySlice = slice.slice(idx, verifyEnd);

      if (verifySlice.indexOf(SEGMENT_ID) !== -1) {
        log.info(
          { candidateOffset, candidatesFound, method: "segment-id" },
          "repair-video: GCS scan found second EBML+Segment header (two-half split)",
        );
        return candidateOffset;
      }

      const verifyStr = verifySlice.toString("binary");
      if (verifyStr.includes("webm") || verifyStr.includes("matroska")) {
        log.info(
          { candidateOffset, candidatesFound, method: "doctype" },
          "repair-video: GCS scan found second EBML header via doctype (two-half split)",
        );
        return candidateOffset;
      }

      pos = idx + 1;
    }
  }
  log.info(
    { candidatesFound, chunkIdx },
    candidatesFound === 0
      ? "repair-video: GCS scan — no EBML magic after MIN_START (single continuous recording)"
      : "repair-video: GCS scan — EBML magic(s) found but none passed verify (single recording)",
  );
  return null;
}

/**
 * Scan a LOCAL file (already downloaded to disk) for the byte offset of a
 * second EBML header — the signature of a raw-concatenated two-half WebM.
 * Uses fs.read so there are no GCS range-read reliability concerns.
 */
async function detectWebMSplitOffsetLocal(filePath: string, log: any): Promise<number | null> {
  const EBML_MAGIC  = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]); // EBML element ID
  const SEGMENT_ID  = Buffer.from([0x18, 0x53, 0x80, 0x67]); // Segment element ID
  const CHUNK       = 16 * 1024 * 1024;  // 16 MB reads
  // The verify window must be large enough to cover the EBML header (typically
  // 36 bytes for WebM) plus the Segment ID that follows it.  The old value of
  // 4 was only enough to bridge the EBML magic itself across a chunk boundary;
  // if the second EBML header landed in the last 116 bytes of any chunk the
  // doctype string fell outside the read buffer and detection silently failed.
  // 300 bytes covers the longest realistic EBML header with room to spare.
  const VERIFY_WINDOW = 300;
  const MIN_START   = 50 * 1024 * 1024;  // skip the first EBML header

  const stat = await fs.stat(filePath);
  const fileSize = stat.size;
  let candidatesFound = 0;
  const fh = await fs.open(filePath, "r");
  try {
    for (let offset = MIN_START; offset < fileSize; offset += CHUNK) {
      // Read CHUNK + VERIFY_WINDOW so that a header found at the very end of
      // the chunk still has its full verify window available in the buffer.
      const length = Math.min(CHUNK + VERIFY_WINDOW, fileSize - offset);
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, offset);
      if (bytesRead < 4) break;
      const slice = buf.subarray(0, bytesRead);

      let pos = 0;
      while (pos <= slice.length - 4) {
        const idx = slice.indexOf(EBML_MAGIC, pos);
        if (idx === -1) break;
        candidatesFound++;
        const candidateOffset = offset + idx;

        const verifyEnd = Math.min(slice.length, idx + VERIFY_WINDOW);
        const verifySlice = slice.slice(idx, verifyEnd);

        // Primary check: the Segment element ID must appear within
        // VERIFY_WINDOW bytes — it always immediately follows the EBML header.
        if (verifySlice.indexOf(SEGMENT_ID) !== -1) {
          log.info(
            { candidateOffset, candidatesFound, method: "segment-id" },
            "repair-video: found second EBML+Segment header (WebM two-half split)",
          );
          return candidateOffset;
        }

        // Fallback: doctype string check (handles non-standard header layouts)
        const verifyStr = verifySlice.toString("binary");
        if (verifyStr.includes("webm") || verifyStr.includes("matroska")) {
          log.info(
            { candidateOffset, candidatesFound, method: "doctype" },
            "repair-video: found second EBML header via doctype (WebM two-half split)",
          );
          return candidateOffset;
        }

        pos = idx + 1;
      }
    }
    log.info(
      { candidatesFound },
      candidatesFound === 0
        ? "repair-video: no EBML magic found after MIN_START — single continuous recording"
        : "repair-video: EBML magic(s) found but none passed verify — treating as single recording",
    );
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
    videoDurationMs: game.videoDurationMs ?? null,
    videoHalf2StartMs: game.videoHalf2StartMs ?? null,
    videoHalftimeGapMs: game.videoHalftimeGapMs ?? null,
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
    const entitlements = await getEntitlementsForUser(req.appUser!);
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

    if (videoObjectPath) scheduleVideoDurationProbe(createdGame.id, videoObjectPath);

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

  // Enforce the "made ≤ attempted" invariant for every stat line.
  // The Zod schema only enforces ≥ 0; this closes the gap where a client
  // could submit ftMade=5, ftAttempted=3 and inflate shooting percentages.
  const invalidStat = body.stats.find(
    (s) =>
      s.ftMade > s.ftAttempted ||
      s.twoMade > s.twoAttempted ||
      s.threeMade > s.threeAttempted,
  );
  if (invalidStat) {
    res.status(400).json({ error: "Made shots cannot exceed attempted shots" });
    return;
  }

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
    const entitlements = await getEntitlementsForUser(req.appUser!);
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
              videoDurationMs: null,
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

  if (videoObjectPath && videoObjectPath !== existing.videoObjectPath) {
    scheduleVideoDurationProbe(gameId, videoObjectPath);
  }

  const serialized = await serializeGame(gameId, ownerId);
  res.json(UpdateGameResponse.parse(serialized));
});

router.delete("/games/:gameId", requireAuth, async (req, res) => {
  const { gameId } = DeleteGameParams.parse(req.params);
  const ownerId = req.appUser!.id;

  // Fetch the game first so we can clean up its GCS objects after deletion.
  const game = await db.query.gamesTable.findFirst({
    where: and(eq(gamesTable.id, gameId), eq(gamesTable.ownerId, ownerId)),
    columns: {
      id: true,
      videoObjectPath: true,
      highlightObjectPath: true,
      lowlightObjectPath: true,
      videoProxyObjectPath: true,
    },
  });

  if (!game) {
    // Row doesn't exist or belongs to another coach — return 204 (idempotent).
    res.status(204).send();
    return;
  }

  // Cancel any in-flight highlight/lowlight/proxy jobs so they stop writing
  // new GCS objects and don't try to update a row that no longer exists.
  cancelHighlightGeneration(gameId);
  cancelProxyBuild(gameId);

  // Delete the DB row first so concurrent requests can no longer reference it.
  await db
    .delete(gamesTable)
    .where(and(eq(gamesTable.id, gameId), eq(gamesTable.ownerId, ownerId)));

  // Delete GCS blobs in parallel. Normalize paths first so legacy rows that
  // stored an absolute GCS URL (instead of /objects/...) are handled correctly.
  // Log errors but don't fail the response — the row is already gone and the
  // blob is orphaned at worst, not cross-accessible.
  const deletions: Promise<void>[] = [];

  const deleteIfPresent = (objectPath: string | null | undefined, label: string) => {
    if (!objectPath) return;
    const normalizedPath = objectStorageService.normalizeObjectEntityPath(objectPath);
    deletions.push(
      objectStorageService.deleteObjectEntity(normalizedPath).catch((err) =>
        req.log.error({ err, objectPath: normalizedPath }, `Failed to delete game ${label} object`)
      ),
    );
  };

  deleteIfPresent(game.videoObjectPath, "video");
  deleteIfPresent(game.highlightObjectPath, "highlight");
  deleteIfPresent(game.lowlightObjectPath, "lowlight");
  deleteIfPresent(game.videoProxyObjectPath, "proxy");

  // Sweep proxy chunks: /objects/uploads/${ownerId}/proxy_chunk_v${PROXY_VERSION}_${gameId}_${i}
  // These intermediate GCS objects are not stored in the DB row — enumerate
  // them until the first miss so any partial or completed proxy encode is
  // fully removed.
  const sweepProxyChunks = async () => {
    let i = 0;
    while (true) {
      const chunkPath = `/objects/uploads/${ownerId}/proxy_chunk_v${PROXY_VERSION}_${gameId}_${i}`;
      try {
        const file = await objectStorageService.getObjectEntityFile(chunkPath);
        const [md] = await file.getMetadata();
        if (!md || Number(md.size ?? 0) === 0) break; // no more chunks
        await objectStorageService.deleteObjectEntity(chunkPath);
        req.log.info({ gameId, chunk: i, chunkPath }, "Deleted proxy chunk for deleted game");
        i++;
      } catch {
        // Object doesn't exist — no more chunks at this index.
        break;
      }
    }
    if (i > 0) {
      req.log.info({ gameId, count: i }, "Proxy chunk sweep complete for deleted game");
    }
  };
  deletions.push(sweepProxyChunks().catch((err) =>
    req.log.error({ err, gameId }, "Failed to sweep proxy chunks for deleted game")
  ));

  await Promise.all(deletions);

  res.status(204).send();
});
/**
 * Returns the best available duration estimate for a game's video in ms.
 * Falls back to max event timestamp + 30 s when videoDurationMs is NULL.
 */
function estimateDurationMs(game: { videoDurationMs: number | null }, events: { videoTimestampMs: number }[]): number {
  if (game.videoDurationMs != null && game.videoDurationMs > 0) return game.videoDurationMs;
  const maxTs = events.reduce((m, e) => Math.max(m, e.videoTimestampMs), 0);
  return maxTs > 0 ? maxTs + 30_000 : 0;
}

/**
 * POST /games/merge
 *
 * Combines 2–10 partial games (recorded after internet dropouts) into a single
 * game record on the same team.  Stats are summed per player; game events are
 * moved to the primary game with video timestamps shifted by the cumulative
 * duration of preceding games' recordings.  Secondary games are marked
 * mergedIntoGameId and hidden from team listings.
 *
 * If 2+ games have video, a background ffmpeg concat job produces a merged
 * video file and updates the primary game's videoObjectPath once done.
 */
router.post("/games/merge", requireAuth, async (req, res) => {
  const body = MergeGamesBody.parse(req.body);
  const ownerId = req.appUser!.id;
  const { primaryGameId, secondaryGameIds } = body;
  const log = req.log;

  if (secondaryGameIds.includes(primaryGameId)) {
    res.status(400).json({ error: "primaryGameId cannot appear in secondaryGameIds" });
    return;
  }

  const allGameIds = [primaryGameId, ...secondaryGameIds];

  const games = await db.query.gamesTable.findMany({
    where: and(inArray(gamesTable.id, allGameIds), eq(gamesTable.ownerId, ownerId)),
  });

  if (games.length !== allGameIds.length) {
    res.status(404).json({ error: "One or more games not found" });
    return;
  }
  if (games.some((g) => g.mergedIntoGameId != null)) {
    res.status(400).json({ error: "One or more games have already been merged into another game" });
    return;
  }
  const teamIds = new Set(games.map((g) => g.teamId));
  if (teamIds.size > 1) {
    res.status(400).json({ error: "All games must be on the same team to merge" });
    return;
  }

  // Sort all games chronologically — this defines the video concat order and
  // determines each game's timestamp offset within the merged recording.
  const ordered = [...games].sort((a, b) => {
    const d = a.date.localeCompare(b.date);
    return d !== 0 ? d : a.createdAt.getTime() - b.createdAt.getTime();
  });

  // Fetch stats and events for all games in one query each.
  const [allStats, allEvents] = await Promise.all([
    db.select().from(playerGameStatsTable).where(inArray(playerGameStatsTable.gameId, allGameIds)),
    db.query.gameEventsTable.findMany({
      where: inArray(gameEventsTable.gameId, allGameIds),
      orderBy: [asc(gameEventsTable.videoTimestampMs)],
    }),
  ]);

  const eventsByGame = new Map<number, typeof allEvents>();
  for (const e of allEvents) {
    const arr = eventsByGame.get(e.gameId) ?? [];
    arr.push(e);
    eventsByGame.set(e.gameId, arr);
  }

  // Build cumulative video-timeline offsets: each game's events are shifted
  // forward by the sum of all preceding games' durations.
  const offsetByGameId = new Map<number, number>();
  let cumulative = 0;
  for (const game of ordered) {
    offsetByGameId.set(game.id, cumulative);
    cumulative += estimateDurationMs(game, eventsByGame.get(game.id) ?? []);
  }

  // Sum stats per player across all games.
  type StatRow = typeof allStats[0];
  const byPlayer = new Map<number, StatRow>();
  for (const s of allStats) {
    const prev = byPlayer.get(s.playerId);
    if (!prev) {
      byPlayer.set(s.playerId, { ...s });
    } else {
      byPlayer.set(s.playerId, {
        ...prev,
        ftMade: prev.ftMade + s.ftMade,
        ftAttempted: prev.ftAttempted + s.ftAttempted,
        twoMade: prev.twoMade + s.twoMade,
        twoAttempted: prev.twoAttempted + s.twoAttempted,
        threeMade: prev.threeMade + s.threeMade,
        threeAttempted: prev.threeAttempted + s.threeAttempted,
        assists: prev.assists + s.assists,
        rebounds: prev.rebounds + s.rebounds,
        steals: prev.steals + s.steals,
        turnovers: prev.turnovers + s.turnovers,
        blocks: prev.blocks + s.blocks,
        goals: prev.goals + s.goals,
        shots: prev.shots + s.shots,
        shotsOffTarget: prev.shotsOffTarget + s.shotsOffTarget,
        saves: prev.saves + s.saves,
        yellowCards: prev.yellowCards + s.yellowCards,
        redCards: prev.redCards + s.redCards,
      });
    }
  }

  // Merged events: reassigned to primary game with adjusted timestamps.
  const mergedEvents = allEvents.map((e) => ({
    gameId: primaryGameId,
    playerId: e.playerId,
    statField: e.statField,
    delta: e.delta,
    videoTimestampMs: e.videoTimestampMs + (offsetByGameId.get(e.gameId) ?? 0),
  }));

  const mergedTeamScore = games.reduce((s, g) => s + g.teamScore, 0);
  const mergedOpponentScore = games.reduce((s, g) => s + g.opponentScore, 0);
  const mergedResult: "W" | "L" = mergedTeamScore >= mergedOpponentScore ? "W" : "L";
  const mergedVideoDurationMs = cumulative > 0 ? cumulative : null;

  await db.transaction(async (tx) => {
    // Update primary game — clear stale reels, update scores + duration.
    await tx
      .update(gamesTable)
      .set({
        teamScore: mergedTeamScore,
        opponentScore: mergedOpponentScore,
        result: mergedResult,
        videoDurationMs: mergedVideoDurationMs,
        highlightObjectPath: null,
        highlightStatus: "idle",
        highlightError: null,
        highlightStartedAt: null,
        highlightGeneratorVersion: null,
        lowlightObjectPath: null,
        lowlightStatus: "idle",
        lowlightError: null,
        lowlightStartedAt: null,
        lowlightGeneratorVersion: null,
        videoProxyObjectPath: null,
        videoProxyVersion: null,
      })
      .where(and(eq(gamesTable.id, primaryGameId), eq(gamesTable.ownerId, ownerId)));

    // Swap in merged stats.
    await tx.delete(playerGameStatsTable).where(eq(playerGameStatsTable.gameId, primaryGameId));
    if (byPlayer.size > 0) {
      await tx.insert(playerGameStatsTable).values(
        [...byPlayer.values()].map((s) => ({
          gameId: primaryGameId,
          playerId: s.playerId,
          ftMade: s.ftMade,
          ftAttempted: s.ftAttempted,
          twoMade: s.twoMade,
          twoAttempted: s.twoAttempted,
          threeMade: s.threeMade,
          threeAttempted: s.threeAttempted,
          assists: s.assists,
          rebounds: s.rebounds,
          steals: s.steals,
          turnovers: s.turnovers,
          blocks: s.blocks,
          goals: s.goals,
          shots: s.shots,
          shotsOffTarget: s.shotsOffTarget,
          saves: s.saves,
          yellowCards: s.yellowCards,
          redCards: s.redCards,
        })),
      );
    }

    // Swap in merged + offset events.
    await tx.delete(gameEventsTable).where(eq(gameEventsTable.gameId, primaryGameId));
    if (mergedEvents.length > 0) {
      await tx.insert(gameEventsTable).values(mergedEvents);
    }

    // Delete secondary games' now-redundant stats and events (data is in primary).
    await tx.delete(playerGameStatsTable).where(inArray(playerGameStatsTable.gameId, secondaryGameIds));
    await tx.delete(gameEventsTable).where(inArray(gameEventsTable.gameId, secondaryGameIds));

    // Mark secondary games as merged (hidden from listings, not deleted).
    await tx
      .update(gamesTable)
      .set({ mergedIntoGameId: primaryGameId })
      .where(and(inArray(gamesTable.id, secondaryGameIds), eq(gamesTable.ownerId, ownerId)));
  });

  // Background video concat when 2+ games have recordings.
  const gamesWithVideo = ordered.filter((g) => g.videoObjectPath);
  if (gamesWithVideo.length >= 2) {
    startBackgroundVideoConcat(primaryGameId, ownerId, gamesWithVideo, log).catch((err) => {
      log.error({ err: String(err?.message ?? err) }, "merge-video: background concat failed");
    });
  } else if (gamesWithVideo.length === 1 && gamesWithVideo[0].id !== primaryGameId) {
    // Only a secondary had video — adopt it onto the primary.
    const donor = gamesWithVideo[0];
    await db
      .update(gamesTable)
      .set({ videoObjectPath: donor.videoObjectPath, videoDurationMs: donor.videoDurationMs })
      .where(eq(gamesTable.id, primaryGameId));
    if (donor.videoObjectPath) scheduleVideoDurationProbe(primaryGameId, donor.videoObjectPath);
  }

  log.info({ primaryGameId, secondaryGameIds }, "merge-games: done");
  const serialized = await serializeGame(primaryGameId, ownerId);
  res.json(MergeGamesResponse.parse(serialized));
});

/**
 * Concatenate the video files from multiple games into a single file, upload
 * it, and update the primary game's videoObjectPath.  Runs in the background
 * after the merge API response has been sent.
 *
 * Uses ffmpeg -f concat -c copy so no re-encode is needed regardless of
 * the source container (WebM or MP4).  The output is the same format as the
 * first input file.
 */
async function startBackgroundVideoConcat(
  primaryGameId: number,
  ownerId: number,
  orderedGames: Array<{ id: number; videoObjectPath: string | null; videoDurationMs: number | null }>,
  log: any,
): Promise<void> {
  const tmpDir = path.join(
    os.tmpdir(),
    `merge-video-${primaryGameId}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await fs.mkdir(tmpDir, { recursive: true });
  try {
    log.info({ primaryGameId, count: orderedGames.length }, "merge-video: downloading source files");

    // Download each game's video to a local file.
    const localPaths: string[] = [];
    for (let i = 0; i < orderedGames.length; i++) {
      const game = orderedGames[i];
      if (!game.videoObjectPath) continue;
      const objectFile = await objectStorageService.getObjectEntityFile(game.videoObjectPath);
      const [meta] = await objectFile.getMetadata();
      const ext = String(meta.contentType ?? "").includes("webm") ? "webm" : "mp4";
      const localPath = path.join(tmpDir, `seg${i}.${ext}`);
      log.info({ gameId: game.id, localPath }, "merge-video: downloading segment");
      await new Promise<void>((resolve, reject) => {
        const ws = createWriteStream(localPath);
        const rs = objectFile.createReadStream();
        rs.on("error", reject);
        ws.on("error", reject);
        ws.on("finish", resolve);
        rs.pipe(ws);
      });
      localPaths.push(localPath);
    }

    if (localPaths.length < 2) {
      log.info({ primaryGameId }, "merge-video: fewer than 2 segments downloaded, skipping concat");
      return;
    }

    // Determine output extension from first segment.
    const firstExt = path.extname(localPaths[0]);
    const outPath = path.join(tmpDir, `merged${firstExt}`);

    // Build ffmpeg concat list file.
    const concatListPath = path.join(tmpDir, "concat.txt");
    const concatContent = localPaths.map((p) => `file '${p}'`).join("\n");
    await fs.writeFile(concatListPath, concatContent, "utf8");

    log.info({ primaryGameId, outPath }, "merge-video: running ffmpeg concat");
    await new Promise<void>((resolve, reject) => {
      execFile(
        "ffmpeg",
        ["-y", "-f", "concat", "-safe", "0", "-i", concatListPath, "-c", "copy", outPath],
        { maxBuffer: 5 * 1024 * 1024, timeout: 10 * 60 * 1000 },
        (err, _stdout, stderr) =>
          err ? reject(new Error(`ffmpeg concat: ${stderr?.slice(-600)}`)) : resolve(),
      );
    });

    log.info({ primaryGameId }, "merge-video: uploading merged file");
    const contentType = firstExt === ".webm" ? "video/webm" : "video/mp4";
    const newObjectPath = await objectStorageService.uploadLocalFileAsObjectEntity(
      outPath,
      ownerId,
      contentType,
    );

    // Guard: if the primary game was deleted while the concat job was running,
    // the newly uploaded blob would be orphaned forever.  Check existence now
    // (after the slow upload) and clean up if the game is gone.
    const stillExists = await db.query.gamesTable.findFirst({
      columns: { id: true },
      where: eq(gamesTable.id, primaryGameId),
    });
    if (!stillExists) {
      log.warn(
        { primaryGameId, newObjectPath },
        "merge-video: primary game deleted mid-job — deleting orphaned blob",
      );
      try {
        const orphanFile = await objectStorageService.getObjectEntityFile(newObjectPath);
        await orphanFile.delete();
      } catch (delErr) {
        log.error(
          { primaryGameId, newObjectPath, err: String(delErr) },
          "merge-video: failed to delete orphaned blob",
        );
      }
      return;
    }

    await db
      .update(gamesTable)
      .set({
        videoObjectPath: newObjectPath,
        videoProxyObjectPath: null,
        videoProxyVersion: null,
        videoDurationMs: null, // will be probed
      })
      .where(eq(gamesTable.id, primaryGameId));

    scheduleVideoDurationProbe(primaryGameId, newObjectPath);
    log.info({ primaryGameId, newObjectPath }, "merge-video: done");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

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

  // Prefer the compressed H.264/AAC "proxy" MP4 for playback when one exists.
  // The raw recording can be a multi-GB cueless WebM (VP9/Opus) that iOS
  // Safari cannot play at all and desktop browsers cannot seek in. The proxy
  // is 720p, faststart, and universally playable.
  const hasValidProxy =
    !!game.videoProxyObjectPath && game.videoProxyVersion === PROXY_VERSION;
  if (!hasValidProxy) {
    // Kick off a background build so this game gets an optimized playback
    // file. No-ops if a build is already running for this game.
    ensureGameProxyInBackground(gameId, ownerId);
  }
  const playbackPath = hasValidProxy ? game.videoProxyObjectPath! : game.videoObjectPath;

  // GCS V4 signed URLs reject any query parameter that wasn't part of the
  // signature, so we must NOT append response-content-type to the signed URL
  // (it returns 403 SignatureDoesNotMatch). Instead, if the object was stored
  // without a video content-type (can happen when blob.type is empty on some
  // devices), patch the object's metadata once so the bare signed URL serves
  // the right Content-Type.
  const objectFile = await objectStorageService.getObjectEntityFile(playbackPath);
  const [metadata] = await objectFile.getMetadata();
  const storedType = (metadata.contentType as string) || "";
  const desiredType = hasValidProxy
    ? "video/mp4"
    : storedType.startsWith("video/") ? storedType : "video/mp4";
  if (storedType !== desiredType) {
    await objectFile.setMetadata({ contentType: desiredType });
  }

  const url = await objectStorageService.getObjectEntitySignedURL(playbackPath, 3600);

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

  const entitlements = await getEntitlementsForUser(req.appUser!);
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
      videoDurationMs: null,
    })
    .where(and(eq(gamesTable.id, gameId), eq(gamesTable.ownerId, ownerId)));

  scheduleVideoDurationProbe(gameId, videoObjectPath);

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
  log.info({ gameId, repairQuality, sourceObjectPath }, "repair-video: starting");
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
      const isWebM = srcContentType.includes("webm");

      if (isWebM) {
        // Scan GCS directly first — no 2+ GB download until we confirm a split.
        // GCS createReadStream is reliable for sequential chunk reads.
        log.info({ gameId, srcFileSize }, "repair-video: GCS-scanning WebM for two-half split");
        const splitOffset = await detectWebMSplitOffsetGCS(srcFile, srcFileSize, log);
        log.info({ gameId, splitOffset }, "repair-video: WebM split scan complete");

        if (splitOffset !== null) {
          // Two-half WebM: download the full file then split + remux.
        const rawFull = path.join(tmpDir, "raw.bin");
          log.info({ gameId }, "repair-video: downloading full WebM for two-half processing");
          await downloadGCSRange(srcFile, rawFull);

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
          // Single continuous WebM — the original file is already a valid playable
          // WebM (VP9/Opus). Attempting to ffmpeg-remux a 2+ GB file on the
          // production server risks an OOM crash before completion.  Instead just
          // reset the metadata: the player uses the original source directly and
          // highlights are regenerated from the correct timestamps.
          log.info({ gameId }, "repair-video: single WebM — skipping ffmpeg, resetting metadata only");
          // Do NOT clear highlight/lowlight reels here: the video file is
          // unchanged (same path, same content), so any existing reels are
          // still valid.  Only nullify half2 fields that the scan now
          // definitively proved don't apply. Clearing reels here caused
          // users to lose their generated reels after pressing Repair when
          // the video was already a single continuous recording.
          await db
            .update(gamesTable)
            .set({
              videoObjectPath:      sourceObjectPath,
              videoProxyObjectPath: null,
              videoProxyVersion:    null,
              videoHalf2StartMs:    null,
              videoHalftimeGapMs:   null,
            })
            .where(eq(gamesTable.id, gameId));
          scheduleVideoDurationProbe(gameId, sourceObjectPath);
          log.info({ gameId }, "repair-video: done (single WebM metadata reset)");
          return; // skip the upload step below; tmpDir cleanup runs in finally
        }
      } else {
        // Non-WebM single segment: download + faststart remux
        const rawFull = path.join(tmpDir, "raw.bin");
        log.info({ gameId }, "repair-video: downloading full source file");
        await downloadGCSRange(srcFile, rawFull);
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
        videoProxyVersion: null,
        highlightStatus: "idle",
        highlightObjectPath: null,
        lowlightStatus: "idle",
        lowlightObjectPath: null,
        videoHalf2StartMs,
        videoHalftimeGapMs,
        videoDurationMs: null,
      })
      .where(eq(gamesTable.id, gameId));

    scheduleVideoDurationProbe(gameId, newObjectPath);

    log.info({ gameId, newObjectPath }, "repair-video: done");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
  })().catch((err) => {
    log.error({ gameId, err: String(err?.message ?? err) }, "repair-video: background job failed");
  });
});

export default router;
