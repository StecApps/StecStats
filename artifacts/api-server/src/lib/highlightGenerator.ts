import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  gamesTable,
  gameEventsTable,
  playersTable,
} from "@workspace/db";
import { ObjectStorageService } from "./objectStorage";
import { logger } from "./logger";

const objectStorageService = new ObjectStorageService();

const FONT_FILE = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

// Seconds of footage kept before and after each qualifying moment.
const PRE_SECONDS = 3.5;
const POST_SECONDS = 3.5;
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

async function setStatus(
  gameId: number,
  status: "processing" | "ready" | "failed",
  extra: { highlightObjectPath?: string | null; highlightError?: string | null } = {},
): Promise<void> {
  await db
    .update(gamesTable)
    .set({ highlightStatus: status, ...extra })
    .where(eq(gamesTable.id, gameId));
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
    const players = playerIds.length
      ? await db.query.playersTable.findMany({
          where: inArray(playersTable.id, playerIds),
        })
      : [];
    const nameById = new Map(players.map((p) => [p.id, p.name]));

    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hl-"));
    const srcPath = path.join(tmpDir, "source");

    // Download the source video to a local temp file.
    const objectFile = await objectStorageService.getObjectEntityFile(game.videoObjectPath);
    await objectFile.download({ destination: srcPath });

    // Probe duration, dimensions and audio presence.
    const durationStr = await ffprobe([
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=nw=1:nk=1",
      srcPath,
    ]);
    const duration = parseFloat(durationStr);
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new HighlightError("Could not read the video duration");
    }

    const dims = await ffprobe([
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-of", "csv=s=x:p=0",
      srcPath,
    ]);
    const height = parseInt(dims.split("x")[1] ?? "720", 10) || 720;

    const audioStreams = await ffprobe([
      "-v", "error",
      "-select_streams", "a",
      "-show_entries", "stream=index",
      "-of", "csv=p=0",
      srcPath,
    ]);
    const hasAudio = audioStreams.length > 0;

    // Build clamped windows, then merge overlapping ones into segments.
    const segments: Segment[] = [];
    for (const e of eligible) {
      const t = Math.min(Math.max(e.videoTimestampMs / 1000, 0), duration);
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
    if (segments.length === 0) {
      throw new HighlightError("No qualifying highlight moments in this game");
    }

    const fontSize = Math.min(96, Math.max(18, Math.round(height / 20)));
    const boxBorder = Math.round(fontSize / 2);
    const margin = Math.round(fontSize * 1.2);

    // Encode each segment (with burned-in captions) to an MPEG-TS chunk.
    const segPaths: string[] = [];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const segDur = seg.end - seg.start;

      const drawFilters = seg.moments.map((m, j) => {
        const local = m.timeSec - seg.start;
        const showStart = Math.max(0, local - CAPTION_HALF_SECONDS).toFixed(2);
        const showEnd = Math.min(segDur, local + CAPTION_HALF_SECONDS).toFixed(2);
        const capFile = path.join(tmpDir!, `cap_${i}_${j}.txt`);
        // Caption text written to a file to avoid filter-escaping issues.
        return { capFile, text: m.caption, showStart, showEnd };
      });

      await Promise.all(
        drawFilters.map((d) => fs.writeFile(d.capFile, d.text, "utf8")),
      );

      const filterParts = ["scale=trunc(iw/2)*2:trunc(ih/2)*2"];
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

      const segPath = path.join(tmpDir, `seg_${i}.ts`);
      const args = [
        "-y",
        "-ss", seg.start.toFixed(3),
        "-i", srcPath,
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

    // Concatenate the TS chunks into a single MP4.
    const listPath = path.join(tmpDir, "list.txt");
    await fs.writeFile(
      listPath,
      segPaths.map((p) => `file '${p}'`).join("\n"),
      "utf8",
    );
    const outPath = path.join(tmpDir, "highlight.mp4");
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

    // Upload the result to object storage.
    const uploadURL = await objectStorageService.getObjectEntityUploadURL();
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

    await setStatus(gameId, "ready", {
      highlightObjectPath: objectPath,
      highlightError: null,
    });
    logger.info({ gameId, segments: segments.length }, "Highlight reel generated");
  } catch (err) {
    const message =
      err instanceof HighlightError
        ? err.message
        : "Highlight generation failed. Please try again.";
    logger.error({ err, gameId }, "Highlight generation failed");
    await setStatus(gameId, "failed", { highlightError: message }).catch(() => {});
    throw err;
  } finally {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
