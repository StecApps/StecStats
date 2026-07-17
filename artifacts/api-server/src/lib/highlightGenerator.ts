import { spawn } from "child_process";
import { promises as fs, createWriteStream } from "fs";
import { pipeline } from "stream/promises";
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
// Watermark PNG: wordmark with boosted orange + ".com" appended.
const LOGO_FILE = path.resolve(__dirname, "..", "assets", "watermark.png");

// Seconds of footage kept before and after each qualifying moment.
// PRE_SECONDS must cover the user's reaction delay (~3-5s after the play)
// plus enough lead-in to see the play develop.
const PRE_SECONDS = 12;
const POST_SECONDS = 2;
// How long each caption stays on screen, centered on its moment.
const CAPTION_HALF_SECONDS = 2.5;

// Target output dimensions for the reel. Lower resolution = much faster
// encoding on CPU-limited containers (was processing at 0.1x real-time at
// full source resolution; 720p + veryfast brings this to ~1.5x).
const OUTPUT_HEIGHT = 720;
const OUTPUT_WIDTH = 1280;

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

// Stat fields that count as "lowlights" — missed shots and turnovers only.
export const LOWLIGHT_FIELDS = new Set([
  "ftAttempted",
  "twoAttempted",
  "threeAttempted",
  "turnovers",
]);

// Maps each "attempted" field to its corresponding "made" field.
const MAKE_PAIR: Record<string, string> = {
  ftAttempted: "ftMade",
  twoAttempted: "twoMade",
  threeAttempted: "threeMade",
};
// How close (in ms) a make event must be to an attempted event to count as the same shot.
const MAKE_PAIR_WINDOW_MS = 15_000;

/**
 * Returns true if the event is a genuine lowlight (turnovers always qualify;
 * "attempted" events only qualify when there is no matching "made" event logged
 * within MAKE_PAIR_WINDOW_MS — i.e., the shot was actually missed).
 */
function isTrueLowlight(
  e: { statField: string; delta: number; videoTimestampMs: number | null },
  allEvents: { statField: string; delta: number; videoTimestampMs: number | null }[],
): boolean {
  if (!(e.delta > 0 && LOWLIGHT_FIELDS.has(e.statField))) return false;
  const makeField = MAKE_PAIR[e.statField];
  if (!makeField) return true; // turnovers — always a lowlight
  // Exclude if a corresponding make was logged within the window (shot was made)
  return !allEvents.some(
    (m) =>
      m.statField === makeField &&
      m.delta > 0 &&
      Math.abs((m.videoTimestampMs ?? 0) - (e.videoTimestampMs ?? 0)) <= MAKE_PAIR_WINDOW_MS,
  );
}

const STAT_LABELS: Record<string, string> = {
  // Highlights
  ftMade: "FT Made",
  twoMade: "2PT Made",
  threeMade: "3PT Made",
  assists: "Assist",
  rebounds: "Rebound",
  steals: "Steal",
  blocks: "Block",
  // Lowlights
  ftAttempted: "FT Miss",
  twoAttempted: "2PT Miss",
  threeAttempted: "3PT Miss",
  turnovers: "Turnover",
};

export class HighlightError extends Error {}

// Maximum time allowed for a single ffmpeg/ffprobe process before SIGKILL.
const PROCESS_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes per segment
// Stall detection: if no bytes arrive within this window, abort the download.
const DOWNLOAD_STALL_MS = 60 * 1000; // 60 seconds of no data = stalled
// Maximum source video size we'll attempt to process.
// The real rendering limit is container disk/memory, not file size per se.
// The default is generous — the actual crash was caused by oversized ffprobe
// buffer flags (probesize=2GB), not the video itself. Those are now fixed.
const MAX_SOURCE_VIDEO_MB = Number(process.env["MAX_SOURCE_VIDEO_MB"] ?? 6000);

/**
 * Download a source video from object storage to a local temp file using the
 * GCS SDK streaming API (file.createReadStream). This avoids signed URLs,
 * which fail on range requests in production (IO error: End of file).
 *
 * Uses a rolling stall-detector (60s with no new bytes = abort) rather than a
 * fixed wall-clock timeout, so large-but-healthy files download fully while
 * truly stalled/truncated GCS objects fail quickly.
 */
async function downloadSourceVideo(objectPath: string, destPath: string): Promise<void> {
  const objectFile = await objectStorageService.getObjectEntityFile(objectPath);

  // Log file size for diagnostics and guard against oversized videos.
  const [meta] = await objectFile.getMetadata();
  const fileSizeBytes = Number(meta.size ?? 0);
  const fileSizeMB = fileSizeBytes / 1024 / 1024;
  logger.info({ objectPath, fileSizeMB: fileSizeMB.toFixed(1) }, "Source video metadata before download");

  if (fileSizeMB > MAX_SOURCE_VIDEO_MB) {
    throw new HighlightError(
      `Video file is too large to process (${fileSizeMB.toFixed(0)} MB). ` +
      `The limit is ${MAX_SOURCE_VIDEO_MB} MB. ` +
      `Please trim the recording to under ${MAX_SOURCE_VIDEO_MB} MB and try again.`
    );
  }

  let bytesReceived = 0;
  let lastByteTime = Date.now();

  const ac = new AbortController();

  // Rolling stall timer: reset every time a data chunk arrives.
  // If 60s pass with no data, abort.
  let stallTimer = setTimeout(() => ac.abort(), DOWNLOAD_STALL_MS);
  const resetStall = () => {
    clearTimeout(stallTimer);
    lastByteTime = Date.now();
    stallTimer = setTimeout(() => ac.abort(), DOWNLOAD_STALL_MS);
  };

  // Progress log every 30s so we can see bytes flowing in deployment logs.
  const progressInterval = setInterval(() => {
    const pct = fileSizeBytes > 0 ? ((bytesReceived / fileSizeBytes) * 100).toFixed(1) : "?";
    const stallSec = ((Date.now() - lastByteTime) / 1000).toFixed(0);
    logger.info({ bytesReceived, fileSizeBytes, pct, stallSec }, "Source video download progress");
  }, 30_000);

  const sourceStream = objectFile.createReadStream();
  sourceStream.on("data", (chunk: Buffer) => {
    bytesReceived += chunk.length;
    resetStall();
  });

  try {
    await pipeline(sourceStream, createWriteStream(destPath), { signal: ac.signal });
    logger.info({ bytesReceived, fileSizeBytes }, "Source video download complete");
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      const pct = fileSizeBytes > 0 ? ((bytesReceived / fileSizeBytes) * 100).toFixed(1) : "?";
      throw new HighlightError(
        `Video download stalled — ${bytesReceived.toLocaleString()} of ${fileSizeBytes.toLocaleString()} bytes received (${pct}%). ` +
        `The stored video may be corrupted or truncated. Try repairing the video then generate the reel again.`
      );
    }
    throw err;
  } finally {
    clearTimeout(stallTimer);
    clearInterval(progressInterval);
  }
}

// ---------------------------------------------------------------------------
// Shared source-video download cache.
//
// Highlight and lowlight jobs for the same game need the same source file.
// Downloading a 2+ GB video twice simultaneously causes OOM kills and fills
// the container's temp disk. This cache ensures only ONE download runs per
// objectPath; subsequent callers wait on the same Promise and share the file.
// Callers must call release() when done so the temp dir can be cleaned up.
// ---------------------------------------------------------------------------
interface SourceVideoEntry {
  promise: Promise<string>; // resolves to local srcPath
  tmpDir: string;
  refs: number;
}
const sourceVideoCache = new Map<string, SourceVideoEntry>();

export async function acquireSourceVideo(
  objectPath: string,
): Promise<{ srcPath: string; release: () => void }> {
  // Check synchronously before any await to be race-condition-safe in Node.js.
  if (!sourceVideoCache.has(objectPath)) {
    const tmpDir = path.join(
      os.tmpdir(),
      `video-src-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const destPath = path.join(tmpDir, "source_video");
    const entry: SourceVideoEntry = {
      promise: fs.mkdir(tmpDir, { recursive: true })
        .then(() => downloadSourceVideo(objectPath, destPath))
        .then(() => destPath)
        .catch((err) => {
          sourceVideoCache.delete(objectPath);
          fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
          throw err;
        }),
      tmpDir,
      refs: 0,
    };
    sourceVideoCache.set(objectPath, entry);
  }

  const entry = sourceVideoCache.get(objectPath)!;
  entry.refs++;

  let srcPath: string;
  try {
    srcPath = await entry.promise;
  } catch (err) {
    entry.refs--;
    throw err;
  }

  const capturedEntry = entry;
  return {
    srcPath,
    release: () => {
      capturedEntry.refs--;
      if (capturedEntry.refs <= 0) {
        sourceVideoCache.delete(objectPath);
        fs.rm(capturedEntry.tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Proxy video cache — a compressed, seekable re-encode of the source stored
// in GCS. Encoding segments from a ~700 MB proxy instead of the raw 2.8 GB
// fMP4 dramatically reduces RAM pressure and seek latency.
//
// On first use: transcodes source → proxy (sequential, low RAM), uploads to
// GCS, saves videoProxyObjectPath in DB.
// On restart / subsequent attempts: downloads the existing ~700 MB proxy from
// GCS instead of re-downloading the 2.8 GB source.
//
// Both highlight and lowlight for the same game share one proxy (ref-counted,
// just like sourceVideoCache). Cache key is the game id.
// ---------------------------------------------------------------------------
const proxyLocalCache = new Map<number, SourceVideoEntry>();

async function acquireGameProxy(
  gameId: number,
  ownerId: number,
  srcPath: string,
): Promise<{ proxyPath: string; release: () => void }> {
  if (!proxyLocalCache.has(gameId)) {
    const tmpDir = path.join(
      os.tmpdir(),
      `video-proxy-${gameId}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const destPath = path.join(tmpDir, "proxy.mp4");
    const entry: SourceVideoEntry = {
      promise: fs.mkdir(tmpDir, { recursive: true })
        .then(async () => {
          // Check DB for a proxy created by a prior run or concurrent job.
          const game = await db.query.gamesTable.findFirst({
            where: eq(gamesTable.id, gameId),
          });
          if (game?.videoProxyObjectPath) {
            logger.info(
              { gameId, objectPath: game.videoProxyObjectPath },
              "Downloading existing proxy video",
            );
            await downloadSourceVideo(game.videoProxyObjectPath, destPath);
            logger.info({ gameId }, "Proxy download complete");
            return destPath;
          }
          // Create proxy: sequential transcode from source.
          // Reads source start-to-end (no random seeks) — minimal RAM even
          // for 2.8 GB inputs. Output has a faststart moov header so duration
          // is always in the header and seeks are O(1) on the small proxy.
          logger.info({ gameId }, "Creating proxy video from source (ultrafast transcode — several minutes)");
          await runFfmpegQueued(
            [
              "-y",
              "-i", srcPath,
              "-c:v", "libx264",
              "-preset", "ultrafast",
              "-crf", "28",
              "-vf",
                `scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease,` +
                `pad=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2`,
              "-c:a", "copy",
              "-movflags", "+faststart",
              destPath,
            ],
            75 * 60 * 1000, // 75 min — generous for a 33-min source
          );
          logger.info({ gameId }, "Proxy created — uploading to storage");
          const proxyObjectPath = await uploadHighlight(destPath, ownerId);
          await db
            .update(gamesTable)
            .set({ videoProxyObjectPath: proxyObjectPath })
            .where(eq(gamesTable.id, gameId));
          logger.info({ gameId, proxyObjectPath }, "Proxy persisted in GCS and DB");
          return destPath;
        })
        .catch((err) => {
          proxyLocalCache.delete(gameId);
          fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
          throw err;
        }),
      tmpDir,
      refs: 0,
    };
    proxyLocalCache.set(gameId, entry);
  }

  const entry = proxyLocalCache.get(gameId)!;
  entry.refs++;
  let proxyPath: string;
  try {
    proxyPath = await entry.promise;
  } catch (err) {
    entry.refs--;
    throw err;
  }
  const capturedEntry = entry;
  return {
    proxyPath,
    release: () => {
      capturedEntry.refs--;
      if (capturedEntry.refs <= 0) {
        proxyLocalCache.delete(gameId);
        fs.rm(capturedEntry.tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}

type Moment = { timeSec: number; caption: string };
type Segment = { start: number; end: number; moments: Moment[] };

function run(cmd: string, args: string[], timeoutMs: number = PROCESS_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stderr = "";
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${cmd} process timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

// Module-level ffmpeg serializer.
// Running two concurrent ffmpeg encode/remux processes on a large source file
// (2+ GB) causes OOM SIGKILL — the decode ring-buffers alone can be several
// hundred MB per process, and two highlight+lowlight jobs typically start at
// the same millisecond. This queue ensures only ONE ffmpeg process is spawned
// at a time, globally, regardless of how many reel jobs are in flight.
let _ffmpegQueueTail: Promise<void> = Promise.resolve();

function runFfmpegQueued(args: string[], timeoutMs?: number): Promise<string> {
  let unlock!: () => void;
  const token = new Promise<void>((r) => { unlock = r; });
  const prev = _ffmpegQueueTail;
  _ffmpegQueueTail = token;
  return prev.then(() => run("ffmpeg", args, timeoutMs)).finally(unlock);
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

async function setGameLowlightStatus(
  gameId: number,
  status: "processing" | "ready" | "failed",
  extra: { lowlightObjectPath?: string | null; lowlightError?: string | null } = {},
): Promise<void> {
  await db
    .update(gamesTable)
    .set({ lowlightStatus: status, ...extra })
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
 * Count lowlight moments (missed shots + turnovers) for a game.
 */
export async function countLowlightMoments(gameId: number): Promise<number> {
  const events = await db.query.gameEventsTable.findMany({
    where: eq(gameEventsTable.gameId, gameId),
  });
  return events.filter((e) => isTrueLowlight(e, events)).length;
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
  offsetMs: number = 0,
): Segment[] {
  const segments: Segment[] = [];
  for (const e of eligible) {
    const adjustedMs = e.videoTimestampMs - offsetMs;
    // Skip events that predate the video (before the recording started).
    if (adjustedMs < 0) continue;
    const tSec = adjustedMs / 1000;
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
  offsetMs: number = 0,
): Promise<string[]> {
  // Duration detection strategy — designed to be safe for large files (3+ GB).
  //
  // IMPORTANT: never set -probesize or -analyzeduration to 2147483647 (2 GB).
  // That value is not a "read everything" flag — it is a literal buffer-size
  // allocation.  On a container that already holds a 3 GB source file, asking
  // ffprobe to allocate another 2 GB causes an immediate OOM kill.
  //
  // Strategy (each step is tried only if the previous one fails):
  //   1. Fast header probe (10 MB) — works for MP4/fMP4 with moov at front.
  //   2. Deeper stream probe (150 MB) — works for most TS / WebM with index.
  //   3. Bitrate estimate — compute duration = size / (bit_rate / 8).
  //      Accurate to ±5% for CBR content; good enough for timestamp mapping.
  //   4. If all else fails, fall back to the old MKV remux ONLY for small
  //      files (< 600 MB) where a second copy won't blow out disk quota.
  //
  // The old MKV remux for large files is deliberately removed — it would write
  // a second copy equal in size to the source, filling the container disk.
  let activeSrcPath = srcPath;

  let durationStr = await ffprobe([
    "-v", "error",
    "-analyzeduration", "10000000",
    "-probesize", "10000000",
    "-show_entries", "format=duration",
    "-of", "default=nw=1:nk=1",
    srcPath,
  ]);
  let duration = parseFloat(durationStr);

  if (!Number.isFinite(duration) || duration <= 0) {
    const streamDurStr = await ffprobe([
      "-v", "error",
      "-analyzeduration", "150000000",
      "-probesize", "150000000",
      "-select_streams", "v:0",
      "-show_entries", "stream=duration",
      "-of", "default=nw=1:nk=1",
      srcPath,
    ]);
    duration = parseFloat(streamDurStr);
  }

  if (!Number.isFinite(duration) || duration <= 0) {
    // Probe 3: larger probesize — reads up to 500 MB from the file.
    // Safe even for 3 GB sources (500 MB << typical container RAM headroom).
    const deepDurStr = await ffprobe([
      "-v", "error",
      "-analyzeduration", "500000000",
      "-probesize", "500000000",
      "-show_entries", "format=duration",
      "-of", "default=nw=1:nk=1",
      srcPath,
    ]).catch(() => "");
    duration = parseFloat(deepDurStr);
  }

  if (!Number.isFinite(duration) || duration <= 0) {
    // Probe 4: attempt same 500 MB scan on the video stream directly.
    const deepStreamDurStr = await ffprobe([
      "-v", "error",
      "-analyzeduration", "500000000",
      "-probesize", "500000000",
      "-select_streams", "v:0",
      "-show_entries", "stream=duration",
      "-of", "default=nw=1:nk=1",
      srcPath,
    ]).catch(() => "");
    duration = parseFloat(deepStreamDurStr);
  }

  if (!Number.isFinite(duration) || duration <= 0) {
    // Probe 5: empirical bitrate estimate.
    // Read the first 90 seconds worth of video packets, measure
    // (totalBytes / elapsed) to get bytes/sec, then scale to file size.
    // This works for VBR streams where the container header has no bit_rate.
    const packetRaw = await ffprobe([
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "packet=pts_time,size",
      "-of", "csv=p=0",
      "-read_intervals", "%+90",
      srcPath,
    ]).catch(() => "");
    const packets = packetRaw.trim().split("\n")
      .map((l) => { const [t, s] = l.split(","); return { t: parseFloat(t), s: Number(s) }; })
      .filter((p) => Number.isFinite(p.t) && p.t >= 0 && p.s > 0);
    if (packets.length > 5) {
      const lastPts = packets[packets.length - 1].t;
      const totalBytes = packets.reduce((acc, p) => acc + p.s, 0);
      if (lastPts > 0 && totalBytes > 0) {
        const empiricalBps = totalBytes / lastPts; // bytes per second
        const srcStatSize = await fs.stat(srcPath).then((s) => s.size).catch(() => 0);
        if (srcStatSize > 0) {
          duration = srcStatSize / empiricalBps;
          logger.info({ prefix, duration, source: "empirical-bitrate", packets: packets.length },
            "Duration estimated from empirical packet bitrate");
        }
      }
    }
  }

  if (!Number.isFinite(duration) || duration <= 0) {
    // Last resort: MKV remux (builds a seek index + duration header).
    // Only safe for small files — remuxing a large file writes a second copy
    // equal in size to the source and will fill the container disk quota.
    const srcStatSize = await fs.stat(srcPath).then((s) => s.size).catch(() => 0);
    const srcMB = srcStatSize / 1024 / 1024;
    if (srcMB > 600) {
      throw new HighlightError(
        "Could not read the video duration. The file may be in an unsupported format. " +
        "Try re-recording the game, or contact support."
      );
    }
    const remuxPath = path.join(tmpDir, `${prefix}_remux.mkv`);
    await run("ffmpeg", [
      "-y",
      "-analyzeduration", "150000000",
      "-probesize", "150000000",
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

  const segments = buildSegments(eligible, duration, nameById, offsetMs);
  if (segments.length === 0) return [];

  // Base caption sizing on OUTPUT dimensions, not source (source may be 4K+).
  const fontSize = Math.min(36, Math.max(12, Math.round(OUTPUT_HEIGHT / 20)));
  const boxBorder = Math.round(fontSize / 2);
  const margin = Math.round(fontSize * 1.2);
  // Logo watermark size: ~5% of output height, with a small margin.
  const wmLogoHeight = Math.max(24, Math.round(OUTPUT_HEIGHT * 0.05));
  const wmLogoMargin = Math.max(8, Math.round(OUTPUT_HEIGHT * 0.018));

  // Run one clip encode at a time. Running parallel ffmpeg processes in
  // production causes OOM kills because the container has limited memory and
  // two jobs (highlight + lowlight) are often running simultaneously.
  const RENDER_CONCURRENCY = 1;

  const renderOne = async (seg: Segment, i: number): Promise<string> => {
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

    const filterParts: string[] = [];
    if (transposeFilter) filterParts.push(transposeFilter);
    filterParts.push(
      `scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease:flags=fast_bilinear,` +
        `scale=trunc(iw/2)*2:trunc(ih/2)*2`,
    );
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
    const mainFilters = filterParts.join(",");
    const filterComplex = [
      `[0:v]${mainFilters}[main]`,
      `[1:v]scale=-1:${wmLogoHeight},format=rgba,colorchannelmixer=aa=0.65[logo]`,
      `[main][logo]overlay=W-w-${wmLogoMargin}:${wmLogoMargin}:shortest=1[out]`,
    ].join(";");

    const segPath = path.join(tmpDir, `seg_${prefix}_${i}.ts`);
    const args = [
      "-y",
      "-ss", seg.start.toFixed(3),
      "-i", activeSrcPath,
      "-loop", "1", "-i", LOGO_FILE,
      "-t", segDur.toFixed(3),
      "-filter_complex", filterComplex,
      "-map", "[out]",
      "-r", "30",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-profile:v", "main",
      "-pix_fmt", "yuv420p",
      "-vsync", "cfr",
      "-b:v", "4500k",
      "-maxrate", "6000k",
      "-bufsize", "12000k",
    ];
    if (hasAudio) {
      args.push("-map", "0:a?", "-c:a", "aac", "-ar", "44100", "-b:a", "128k", "-ac", "2");
    } else {
      args.push("-an");
    }
    args.push("-reset_timestamps", "1");
    args.push("-f", "mpegts", segPath);

    await runFfmpegQueued(args);
    return segPath;
  };

  // Process in ordered batches — results within each batch are parallel but
  // the overall array order matches segment order for the concat step.
  const segPaths: string[] = [];
  for (let b = 0; b < segments.length; b += RENDER_CONCURRENCY) {
    const batch = segments.slice(b, b + RENDER_CONCURRENCY);
    const results = await Promise.all(batch.map((seg, j) => renderOne(seg, b + j)));
    segPaths.push(...results);
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
  await runFfmpegQueued(concatArgs);
}

async function uploadHighlight(outPath: string, ownerId: number): Promise<string> {
  const buffer = await fs.readFile(outPath);
  const MAX_ATTEMPTS = 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const uploadURL = await objectStorageService.getObjectEntityUploadURL(ownerId);
    try {
      const putRes = await fetch(uploadURL, {
        method: "PUT",
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": String(buffer.byteLength),
        },
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
    } catch (err) {
      lastErr = err;
      if (err instanceof HighlightError) throw err;
      if (attempt < MAX_ATTEMPTS) {
        const delayMs = attempt * 5000;
        logger.warn({ err, attempt, delayMs, outPath }, "Upload attempt failed, retrying");
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}

/**
 * Generate an MP4 highlight reel for a game and persist the result.
 * Runs fully async (fire-and-forget); progress is tracked via the game's
 * highlightStatus column.
 */
export async function generateHighlight(gameId: number): Promise<void> {
  let tmpDir: string | null = null;
  let releaseSourceVideo: (() => void) | null = null;
  let releaseProxy: (() => void) | null = null;
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

    // Shared download: highlight + lowlight for the same game share one copy.
    // Avoids the OOM/disk-full crash caused by two simultaneous 2+ GB downloads.
    logger.info({ gameId }, "Downloading source video for highlight generation");
    const { srcPath, release } = await acquireSourceVideo(game.videoObjectPath);
    releaseSourceVideo = release;
    logger.info({ gameId }, "Source video ready for highlight generation");

    // Create/download a compressed proxy (~700 MB) from the raw source.
    // Encoding from the proxy instead of the 2.8 GB source eliminates the OOM
    // kills and SIGTERM-during-seek issues: the proxy is seekable in O(1),
    // fits comfortably in container memory, and is cached in GCS so restarts
    // skip the expensive re-transcode and just download the small proxy.
    const { proxyPath, release: releaseP } = await acquireGameProxy(
      gameId,
      game.ownerId,
      srcPath,
    );
    releaseProxy = releaseP;

    // Release the 2.8 GB source immediately — the proxy is all we need now.
    releaseSourceVideo?.();
    releaseSourceVideo = null;

    const audioStreams = await ffprobe([
      "-v", "error",
      "-select_streams", "a",
      "-show_entries", "stream=index",
      "-of", "csv=p=0",
      proxyPath,
    ]);
    const hasAudio = audioStreams.length > 0;

    const segPaths = await renderGameSegments(proxyPath, tmpDir, "g", eligible, nameById, game.videoOffsetMs ?? 0);
    if (segPaths.length === 0) {
      throw new HighlightError("No qualifying highlight moments in this game");
    }

    releaseProxy?.();
    releaseProxy = null;

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
    releaseSourceVideo?.();
    releaseProxy?.();
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * Generate an MP4 lowlight reel for a game (missed shots + turnovers).
 * Runs fully async (fire-and-forget); progress is tracked via the game's
 * lowlightStatus column.
 */
export async function generateLowlight(gameId: number): Promise<void> {
  let tmpDir: string | null = null;
  let releaseSourceVideo: (() => void) | null = null;
  let releaseProxy: (() => void) | null = null;
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
    const eligible = events.filter((e) => isTrueLowlight(e, events));
    if (eligible.length === 0) {
      throw new HighlightError("No lowlight moments tagged in this game");
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

    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ll-"));

    // Shared download: reuses the same source file if highlight is already
    // downloading or has downloaded it — avoids the double 2+ GB OOM crash.
    logger.info({ gameId }, "Downloading source video for lowlight generation");
    const { srcPath, release } = await acquireSourceVideo(game.videoObjectPath);
    releaseSourceVideo = release;
    logger.info({ gameId }, "Source video ready for lowlight generation");

    // Acquire the compressed proxy (shared with highlight job for the same game).
    const { proxyPath, release: releaseP } = await acquireGameProxy(
      gameId,
      game.ownerId,
      srcPath,
    );
    releaseProxy = releaseP;

    // Release the 2.8 GB source — the proxy is sufficient for all encoding.
    releaseSourceVideo?.();
    releaseSourceVideo = null;

    const audioStreams = await ffprobe([
      "-v", "error",
      "-select_streams", "a",
      "-show_entries", "stream=index",
      "-of", "csv=p=0",
      proxyPath,
    ]);
    const hasAudio = audioStreams.length > 0;

    const segPaths = await renderGameSegments(proxyPath, tmpDir, "ll", eligible, nameById, game.videoOffsetMs ?? 0);
    if (segPaths.length === 0) {
      throw new HighlightError("No lowlight moments could be rendered");
    }

    releaseProxy?.();
    releaseProxy = null;

    const outPath = path.join(tmpDir, "lowlight.mp4");
    await concatSegments(segPaths, tmpDir, outPath, hasAudio);

    const objectPath = await uploadHighlight(outPath, game.ownerId);

    await setGameLowlightStatus(gameId, "ready", {
      lowlightObjectPath: objectPath,
      lowlightError: null,
    });
    logger.info({ gameId, segments: segPaths.length }, "Lowlight reel generated");
  } catch (err) {
    const message =
      err instanceof HighlightError
        ? err.message
        : "Lowlight generation failed. Please try again.";
    logger.error({ err, gameId }, "Lowlight generation failed");
    await setGameLowlightStatus(gameId, "failed", { lowlightError: message }).catch(() => {});
    throw err;
  } finally {
    releaseSourceVideo?.();
    releaseProxy?.();
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

        const srcPath = path.join(tmpDir!, `src_${game.id}`);
        logger.info({ gameId: game.id }, "Downloading source video for team highlight");
        await downloadSourceVideo(game.videoObjectPath!, srcPath);

        const audioProbe = await ffprobe([
          "-v", "error",
          "-select_streams", "a",
          "-show_entries", "stream=index",
          "-of", "csv=p=0",
          srcPath,
        ]);
        const hasAudio = audioProbe.length > 0;

        const segPaths = await renderGameSegments(srcPath, tmpDir!, `t${game.id}`, eligible, nameById, game.videoOffsetMs ?? 0);
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
