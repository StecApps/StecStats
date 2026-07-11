import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  gamesTable,
  gameEventsTable,
  playersTable,
  teamsTable,
} from "@workspace/db";
import { ObjectStorageService } from "./objectStorage";
import { logger } from "./logger";

const objectStorageService = new ObjectStorageService();

const FONT_FILE = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

// Seconds of footage kept before and after each qualifying moment.
const PRE_SECONDS = 20;
const POST_SECONDS = 20;
// How long each caption stays on screen, centered on its moment.
const CAPTION_HALF_SECONDS = 2.5;

// Stat fields that count as "highlights" — made shots and positive plays only.
export const HIGHLIGHT_FIELDS = new Set([
  "twoMade",
  "threeMade",
  "ftMade",
  "rebounds",
  "assists",
  "steals",
  "blocks",
]);

const STAT_LABELS: Record<string, string> = {
  ftMade: "FT Made",
  twoMade: "2PT Made",
  threeMade: "3PT Made",
  assists: "Assist",
  rebounds: "Rebound",
  steals: "Steal",
  blocks: "Block",
};

export class HighlightError extends Error {}

type Moment = { timeSec: number; caption: string };
type Segment = { start: number; end: number; moments: Moment[] };

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stderr = "";
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

async function ffprobe(args: string[]): Promise<string> {
  return (await run("ffprobe", args)).trim();
}

async function setGameStatus(
  gameId: number,
  status: "processing" | "ready" | "failed",
  extra: { highlightObjectPath?: string | null; highlightError?: string | null } = {},
): Promise<void> {
  await db
    .update(gamesTable)
    .set({ highlightStatus: status, ...extra })
    .where(eq(gamesTable.id, gameId));
}

async function setTeamStatus(
  teamId: number,
  status: "processing" | "ready" | "failed",
  extra: { highlightObjectPath?: string | null; highlightError?: string | null } = {},
): Promise<void> {
  await db
    .update(teamsTable)
    .set({ highlightStatus: status, ...extra })
    .where(eq(teamsTable.id, teamId));
}

/**
 * Count qualifying moments for a game without generating anything.
 */
export async function countEligibleMoments(gameId: number): Promise<number> {
  const events = await db.query.gameEventsTable.findMany({
    where: eq(gameEventsTable.gameId, gameId),
  });
  return events.filter((e) => e.delta > 0 && HIGHLIGHT_FIELDS.has(e.statField)).length;
}

/**
 * Count qualifying moments across every video-having game on a team.
 */
export async function countEligibleMomentsForTeam(teamId: number): Promise<number> {
  const games = await db.query.gamesTable.findMany({
    where: eq(gamesTable.teamId, teamId),
  });
  const videoGameIds = games.filter((g) => g.videoObjectPath).map((g) => g.id);
  if (videoGameIds.length === 0) return 0;
  const events = await db.query.gameEventsTable.findMany({
    where: inArray(gameEventsTable.gameId, videoGameIds),
  });
  return events.filter((e) => e.delta > 0 && HIGHLIGHT_FIELDS.has(e.statField)).length;
}

function buildSegments(
  eligible: { videoTimestampMs: number; playerId: number; statField: string }[],
  duration: number,
  nameById: Map<number, string>,
): Segment[] {
  const segments: Segment[] = [];
  for (const e of eligible) {
    const tSec = e.videoTimestampMs / 1000;
    // Skip events beyond the video's duration — the recording ended before
    // this play happened (e.g. the browser stopped writing chunks early).
    // Clamping to `duration` would silently map every out-of-range event to
    // the last frame and produce a garbage highlight of pre-game footage.
    if (tSec <= 0 || tSec >= duration) continue;
    const t = tSec;
    const start = Math.max(0, t - PRE_SECONDS);
    const end = Math.min(duration, t + POST_SECONDS);
    if (end - start < 0.5) continue;
    const label = STAT_LABELS[e.statField] ?? e.statField;
    const name = nameById.get(e.playerId) ?? "Player";
    const moment: Moment = { timeSec: t, caption: `${name} \u2014 ${label}` };
    const last = segments[segments.length - 1];
    if (last && start <= last.end) {
      last.end = Math.max(last.end, end);
      last.moments.push(moment);
    } else {
      segments.push({ start, end, moments: [moment] });
    }
  }
  return segments;
}

/**
 * Renders one game's qualifying segments (source video already downloaded to
 * `srcPath`) into a list of captioned MPEG-TS chunks under `tmpDir`, prefixed
 * with `prefix` so multiple games can render into the same tmp dir without
 * filename collisions. Returns the list of chunk paths in playback order.
 */
async function renderGameSegments(
  srcPath: string,
  tmpDir: string,
  prefix: string,
  eligible: { videoTimestampMs: number; playerId: number; statField: string }[],
  nameById: Map<number, string>,
): Promise<string[]> {
  // MediaRecorder WebM files often lack a container-level duration header AND
  // have no seek index (cue points), making -ss seeks extremely slow.
  // Strategy: try cheap probes first; if they fail, remux to MKV (copy-only,
  // fast) which writes both a duration header and cue points.  All subsequent
  // probes and segment extractions use activeSrcPath so seeking is O(1).
  let activeSrcPath = srcPath;

  let durationStr = await ffprobe([
    "-v", "error",
    "-analyzeduration", "2147483647",
    "-probesize", "2147483647",
    "-show_entries", "format=duration",
    "-of", "default=nw=1:nk=1",
    srcPath,
  ]);
  let duration = parseFloat(durationStr);

  if (!Number.isFinite(duration) || duration <= 0) {
    const streamDurStr = await ffprobe([
      "-v", "error",
      "-analyzeduration", "2147483647",
      "-probesize", "2147483647",
      "-select_streams", "v:0",
      "-show_entries", "stream=duration",
      "-of", "default=nw=1:nk=1",
      srcPath,
    ]);
    duration = parseFloat(streamDurStr);
  }

  if (!Number.isFinite(duration) || duration <= 0) {
    // Remux to MKV: ffmpeg rewrites the container with a duration header and
    // cue points, enabling accurate random-access seeking for all later steps.
    // Keep the remuxed file alive; it becomes activeSrcPath.
    const remuxPath = path.join(tmpDir, `${prefix}_remux.mkv`);
    await run("ffmpeg", [
      "-y",
      "-analyzeduration", "2147483647",
      "-probesize", "2147483647",
      "-i", srcPath,
      "-c", "copy",
      remuxPath,
    ]);
    const remuxDurStr = await ffprobe([
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=nw=1:nk=1",
      remuxPath,
    ]);
    duration = parseFloat(remuxDurStr);
    activeSrcPath = remuxPath;
  }

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new HighlightError("Could not read the video duration");
  }

  const dims = await ffprobe([
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-of", "csv=s=x:p=0",
    activeSrcPath,
  ]);
  let rawWidth  = parseInt(dims.split("x")[0] ?? "1280", 10) || 1280;
  let rawHeight = parseInt(dims.split("x")[1] ?? "720",  10) || 720;

  // Some iOS versions incorrectly stamp a `rotate` tag onto canvas-recorded
  // streams.  ffmpeg re-encodes with the raw pixels and ignores the tag by
  // default, so we detect it here and apply a transpose filter to physically
  // rotate the pixels before encoding — giving the highlight reel the correct
  // orientation instead of sideways/stretched output.
  const rotateMeta = await ffprobe([
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream_tags=rotate",
    "-of", "default=nw=1:nk=1",
    activeSrcPath,
  ]).catch(() => "0");
  const rotationDeg = parseInt(rotateMeta.trim() || "0", 10) || 0;

  // After a 90°/270° transpose the logical width ↔ height swap.
  let displayWidth  = rawWidth;
  let displayHeight = rawHeight;
  let transposeFilter: string | null = null;
  if (rotationDeg === 90) {
    transposeFilter = "transpose=1";           // 90° CW
    [displayWidth, displayHeight] = [rawHeight, rawWidth];
  } else if (rotationDeg === 270 || rotationDeg === -90) {
    transposeFilter = "transpose=2";           // 90° CCW
    [displayWidth, displayHeight] = [rawHeight, rawWidth];
  } else if (rotationDeg === 180) {
    transposeFilter = "transpose=1,transpose=1"; // 180°
  }

  const height = displayHeight;

  const audioStreams = await ffprobe([
    "-v", "error",
    "-select_streams", "a",
    "-show_entries", "stream=index",
    "-of", "csv=p=0",
    activeSrcPath,
  ]);
  const hasAudio = audioStreams.length > 0;

  const segments = buildSegments(eligible, duration, nameById);
  if (segments.length === 0) return [];

  const fontSize = Math.min(96, Math.max(18, Math.round(height / 20)));
  const boxBorder = Math.round(fontSize / 2);
  const margin = Math.round(fontSize * 1.2);

  const segPaths: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const segDur = seg.end - seg.start;

    const drawFilters = seg.moments.map((m, j) => {
      const local = m.timeSec - seg.start;
      const showStart = Math.max(0, local - CAPTION_HALF_SECONDS).toFixed(2);
      const showEnd = Math.min(segDur, local + CAPTION_HALF_SECONDS).toFixed(2);
      const capFile = path.join(tmpDir, `cap_${prefix}_${i}_${j}.txt`);
      return { capFile, text: m.caption, showStart, showEnd };
    });

    await Promise.all(
      drawFilters.map((d) => fs.writeFile(d.capFile, d.text, "utf8")),
    );

    // Build filter chain: optional rotation correction first, then scale to
    // ensure even dimensions (required by H.264), then captions.
    const filterParts: string[] = [];
    if (transposeFilter) filterParts.push(transposeFilter);
    filterParts.push("scale=trunc(iw/2)*2:trunc(ih/2)*2");
    for (const d of drawFilters) {
      filterParts.push(
        [
          `drawtext=fontfile=${FONT_FILE}`,
          `textfile=${d.capFile}`,
          `fontcolor=white`,
          `fontsize=${fontSize}`,
          `box=1`,
          `boxcolor=black@0.55`,
          `boxborderw=${boxBorder}`,
          `x=(w-text_w)/2`,
          `y=h-text_h-${margin}`,
          `enable='between(t,${d.showStart},${d.showEnd})'`,
        ].join(":"),
      );
    }
    const vf = filterParts.join(",");

    const segPath = path.join(tmpDir, `seg_${prefix}_${i}.ts`);
    const args = [
      "-y",
      "-ss", seg.start.toFixed(3),
      "-i", activeSrcPath,
      "-t", segDur.toFixed(3),
      "-vf", vf,
      "-r", "30",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-profile:v", "high",
      "-pix_fmt", "yuv420p",
      "-vsync", "cfr",
    ];
    if (hasAudio) {
      args.push("-c:a", "aac", "-ar", "44100", "-b:a", "128k", "-ac", "2");
    } else {
      args.push("-an");
    }
    args.push("-f", "mpegts", segPath);

    await run("ffmpeg", args);
    segPaths.push(segPath);
  }

  return segPaths;
}

async function concatSegments(
  segPaths: string[],
  tmpDir: string,
  outPath: string,
  hasAudio: boolean,
): Promise<void> {
  const listPath = path.join(tmpDir, `list_${path.basename(outPath)}.txt`);
  await fs.writeFile(
    listPath,
    segPaths.map((p) => `file '${p}'`).join("\n"),
    "utf8",
  );
  const concatArgs = [
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", listPath,
    "-c", "copy",
  ];
  if (hasAudio) concatArgs.push("-bsf:a", "aac_adtstoasc");
  concatArgs.push("-movflags", "+faststart", outPath);
  await run("ffmpeg", concatArgs);
}

async function uploadHighlight(outPath: string, ownerId: number): Promise<string> {
  const uploadURL = await objectStorageService.getObjectEntityUploadURL(ownerId);
  const buffer = await fs.readFile(outPath);
  const putRes = await fetch(uploadURL, {
    method: "PUT",
    headers: { "Content-Type": "video/mp4" },
    body: buffer,
  });
  if (!putRes.ok) {
    throw new HighlightError(`Failed to upload highlight (${putRes.status})`);
  }
  const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);
  await objectStorageService
    .trySetObjectEntityAclPolicy(objectPath, {
      owner: String(ownerId),
      visibility: "private",
    })
    .catch((err) => logger.error({ err, ownerId }, "Failed to set highlight ACL policy"));
  return objectPath;
}

/**
 * Generate an MP4 highlight reel for a game and persist the result.
 * Runs fully async (fire-and-forget); progress is tracked via the game's
 * highlightStatus column.
 */
export async function generateHighlight(gameId: number): Promise<void> {
  let tmpDir: string | null = null;
  try {
    const game = await db.query.gamesTable.findFirst({
      where: eq(gamesTable.id, gameId),
    });
    if (!game) throw new HighlightError("Game not found");
    if (!game.videoObjectPath) throw new HighlightError("This game has no recorded video");
    if (game.ownerId == null) throw new HighlightError("This game has no owner account");

    const events = await db.query.gameEventsTable.findMany({
      where: eq(gameEventsTable.gameId, gameId),
      orderBy: (e, { asc }) => [asc(e.videoTimestampMs)],
    });
    const eligible = events.filter(
      (e) => e.delta > 0 && HIGHLIGHT_FIELDS.has(e.statField),
    );
    if (eligible.length === 0) {
      throw new HighlightError("No qualifying highlight moments in this game");
    }

    const playerIds = Array.from(new Set(eligible.map((e) => e.playerId)));
    const players =
      playerIds.length && game.ownerId != null
        ? await db.query.playersTable.findMany({
            where: and(
              inArray(playersTable.id, playerIds),
              eq(playersTable.ownerId, game.ownerId),
            ),
          })
        : [];
    const nameById = new Map(players.map((p) => [p.id, p.name]));

    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hl-"));
    const srcPath = path.join(tmpDir, "source");

    const objectFile = await objectStorageService.getObjectEntityFile(game.videoObjectPath);
    await objectFile.download({ destination: srcPath });

    const audioStreams = await ffprobe([
      "-v", "error",
      "-select_streams", "a",
      "-show_entries", "stream=index",
      "-of", "csv=p=0",
      srcPath,
    ]);
    const hasAudio = audioStreams.length > 0;

    const segPaths = await renderGameSegments(srcPath, tmpDir, "g", eligible, nameById);
    if (segPaths.length === 0) {
      throw new HighlightError("No qualifying highlight moments in this game");
    }

    const outPath = path.join(tmpDir, "highlight.mp4");
    await concatSegments(segPaths, tmpDir, outPath, hasAudio);

    const objectPath = await uploadHighlight(outPath, game.ownerId);

    await setGameStatus(gameId, "ready", {
      highlightObjectPath: objectPath,
      highlightError: null,
    });
    logger.info({ gameId, segments: segPaths.length }, "Highlight reel generated");
  } catch (err) {
    const message =
      err instanceof HighlightError
        ? err.message
        : "Highlight generation failed. Please try again.";
    logger.error({ err, gameId }, "Highlight generation failed");
    await setGameStatus(gameId, "failed", { highlightError: message }).catch(() => {});
    throw err;
  } finally {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * Generate one combined MP4 highlight reel across every video-having game on
 * a team, in date order. Runs fully async (fire-and-forget); progress is
 * tracked via the team's highlightStatus column.
 */
export async function generateTeamHighlight(teamId: number): Promise<void> {
  let tmpDir: string | null = null;
  try {
    const team = await db.query.teamsTable.findFirst({
      where: eq(teamsTable.id, teamId),
    });
    if (!team) throw new HighlightError("Team not found");
    if (team.ownerId == null) throw new HighlightError("This team has no owner account");

    const games = await db.query.gamesTable.findMany({
      where: eq(gamesTable.teamId, teamId),
      orderBy: (g, { asc }) => [asc(g.date), asc(g.id)],
    });
    const videoGames = games.filter((g) => g.videoObjectPath);
    if (videoGames.length === 0) {
      throw new HighlightError("None of this team's games have a recorded video yet");
    }

    const gameIds = videoGames.map((g) => g.id);
    const allEvents = await db.query.gameEventsTable.findMany({
      where: inArray(gameEventsTable.gameId, gameIds),
      orderBy: (e, { asc }) => [asc(e.videoTimestampMs)],
    });
    const eventsByGame = new Map<number, typeof allEvents>();
    for (const e of allEvents) {
      if (e.delta <= 0 || !HIGHLIGHT_FIELDS.has(e.statField)) continue;
      const list = eventsByGame.get(e.gameId) ?? [];
      list.push(e);
      eventsByGame.set(e.gameId, list);
    }

    const eligibleGameIds = gameIds.filter((id) => (eventsByGame.get(id)?.length ?? 0) > 0);
    if (eligibleGameIds.length === 0) {
      throw new HighlightError("No qualifying highlight moments across this team's games");
    }

    const playerIds = Array.from(
      new Set(Array.from(eventsByGame.values()).flat().map((e) => e.playerId)),
    );
    const players = playerIds.length
      ? await db.query.playersTable.findMany({
          where: and(inArray(playersTable.id, playerIds), eq(playersTable.ownerId, team.ownerId)),
        })
      : [];
    const nameById = new Map(players.map((p) => [p.id, p.name]));

    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hl-team-"));

    // Process each game in parallel: download + remux + segment extraction all
    // run concurrently so total time ≈ slowest game instead of sum of all games.
    const gameResults = await Promise.all(
      videoGames.map(async (game) => {
        const eligible = eventsByGame.get(game.id);
        if (!eligible || eligible.length === 0) return { segPaths: [], hasAudio: false };

        const srcPath = path.join(tmpDir!, `source_${game.id}`);
        const objectFile = await objectStorageService.getObjectEntityFile(game.videoObjectPath!);
        await objectFile.download({ destination: srcPath });

        const audioProbe = await ffprobe([
          "-v", "error",
          "-select_streams", "a",
          "-show_entries", "stream=index",
          "-of", "csv=p=0",
          srcPath,
        ]);
        const hasAudio = audioProbe.length > 0;

        const segPaths = await renderGameSegments(srcPath, tmpDir!, `t${game.id}`, eligible, nameById);
        return { segPaths, hasAudio };
      }),
    );

    // Flatten in game date order (videoGames is already ordered by date + id)
    const allSegPaths = gameResults.flatMap((r) => r.segPaths);
    const anyAudio = gameResults.some((r) => r.hasAudio);

    if (allSegPaths.length === 0) {
      throw new HighlightError("No qualifying highlight moments across this team's games");
    }

    const outPath = path.join(tmpDir, "season-highlight.mp4");
    await concatSegments(allSegPaths, tmpDir, outPath, anyAudio);

    const objectPath = await uploadHighlight(outPath, team.ownerId);

    await setTeamStatus(teamId, "ready", {
      highlightObjectPath: objectPath,
      highlightError: null,
    });
    logger.info(
      { teamId, games: videoGames.length, segments: allSegPaths.length },
      "Season highlight reel generated",
    );
  } catch (err) {
    const message =
      err instanceof HighlightError
        ? err.message
        : "Highlight generation failed. Please try again.";
    logger.error({ err, teamId }, "Season highlight generation failed");
    await setTeamStatus(teamId, "failed", { highlightError: message }).catch(() => {});
    throw err;
  } finally {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
