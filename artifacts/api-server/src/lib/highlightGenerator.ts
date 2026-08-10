import { spawn } from "child_process";
import { promises as fs, createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { randomUUID } from "crypto";
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

// Separate per-game abort controllers for highlight vs lowlight jobs.
// Using a shared map caused the second job to overwrite the first's
// controller, so Cancel aborted the wrong signal and the proxy download
// (which uses the first job's signal) kept running, causing OOM loops.
const highlightAbortControllers = new Map<number, AbortController>();
const lowlightAbortControllers = new Map<number, AbortController>();
const proxyBuildAbortControllers = new Map<number, AbortController>();
export function cancelHighlightJob(gameId: number): void {
  highlightAbortControllers.get(gameId)?.abort();
}
export function cancelLowlightJob(gameId: number): void {
  lowlightAbortControllers.get(gameId)?.abort();
}
export function cancelProxyBuild(gameId: number): void {
  proxyBuildAbortControllers.get(gameId)?.abort();
}
/** @deprecated use cancelHighlightJob / cancelLowlightJob */
export function cancelHighlightGeneration(gameId: number): void {
  cancelHighlightJob(gameId);
  cancelLowlightJob(gameId);
}

// ---------------------------------------------------------------------------
// Module-level shared chunk download cache.
// Concurrent highlight and lowlight jobs for the same game share downloaded
// proxy chunks rather than each fetching a separate copy — up to 2× fewer GCS
// downloads per session.  Key = GCS object path (unique per game/version/index).
// Reference-counted: the file is deleted only after the last job releases it.
// ---------------------------------------------------------------------------
interface _SharedChunkEntry {
  promise: Promise<string>;
  refs: number;
  localPath: string;
}
const _sharedChunkCache = new Map<string, _SharedChunkEntry>();

async function _acquireSharedChunk(objectPath: string): Promise<string> {
  let entry = _sharedChunkCache.get(objectPath);
  if (!entry) {
    const safe = objectPath.replace(/[^a-zA-Z0-9_.-]/g, "_");
    const localPath = path.join(os.tmpdir(), `shpchunk_${safe}.mp4`);
    // Download without a job-specific AbortSignal so that cancelling one job
    // (e.g. highlight) does not abort a download the sibling job (lowlight)
    // also needs.  Each job checks its own signal before calling this.
    const promise = downloadSourceVideo(objectPath, localPath).then(() => localPath);
    entry = { promise, refs: 0, localPath };
    _sharedChunkCache.set(objectPath, entry);
  }
  entry.refs++;
  return entry.promise;
}

async function _releaseSharedChunk(objectPath: string): Promise<void> {
  const entry = _sharedChunkCache.get(objectPath);
  if (!entry) return;
  entry.refs--;
  if (entry.refs <= 0) {
    _sharedChunkCache.delete(objectPath);
    await fs.unlink(entry.localPath).catch(() => {});
  }
}

const FONT_FILE = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
// Watermark PNG: wordmark with boosted orange + ".com" appended.
const LOGO_FILE = path.resolve(__dirname, "..", "assets", "watermark.png");

// Seconds of footage kept before and after each qualifying moment.
//
// Sideline mode stores timestamps 10 s BEFORE the user's tap (via
// SIDELINE_TIMESTAMP_OFFSET_MS = -10_000), so the stored timestamp already
// points to roughly when the play was developing.  POST_SECONDS must extend
// far enough past the stored timestamp to capture the play completion and a
// bit of celebration/result — ~10-13 s forward from the stored moment.
// Using POST_SECONDS = 15 means the clip ends ~15 s after the stored ts,
// safely showing the play + 2-5 s of result for both sideline and regular mode.
// PRE_SECONDS = 18: nominal lead-in is 18 s.  The proxy segment muxer cuts
// each chunk at the next keyframe after PROXY_CHUNK_DURATION_SEC, so actual
// chunk boundaries can lag the nominal by up to one keyframe interval (≤ 2 s
// with -force_key_frames every 2 s, ≤ ~8 s with the old default 250-frame GOP
// at 30 fps).  For a game where n chunks are skipped before the first needed
// chunk, cumulative drift = n × per-chunk-drift.  Game 161 had 3 skipped
// chunks with the old 4 s keyframe interval → 12 s drift → 0 s lead-in.
// 18 s gives 6 s buffer over that observed worst case, and with the new
// -force_key_frames encoding the drift is ≤ 2 s per skipped chunk so
// lead-in is guaranteed ≥ 18 - 3×2 = 12 s even for a long game.
const PRE_SECONDS = 18;
const POST_SECONDS = 2;

// Hard cap on a single (merged) segment's length. buildSegments merges
// overlapping moments, and a dense scoring stretch can otherwise chain into
// one enormous segment. The cap MUST stay below PROXY_CHUNK_DURATION_SEC
// (360 s) so any segment spans at most 2 proxy chunks — chunk-based
// extraction keeps at most 2 chunks (~550 MB) in the RAM-backed /tmp at a
// time, which is what prevents OOM kills in the production container.
const MAX_SEGMENT_SEC = 300;

// Version stamp written to the DB alongside every generated reel. Bump this
// whenever clip-timing logic changes (PRE/POST_SECONDS, offset handling, …)
// so reels cached under the old logic are invalidated on read and rebuilt.
// v2 = POST_SECONDS 2→15 fix (clips used to end before the play happened).
// v3 = fix chunk-boundary lead-in clipping: seg.start in prev chunk now uses
//      concat-demuxer path instead of clamping seek to 0 (missing first ~10s).
// v4 = streaming GCS upload (no more "other side closed" on large lowlights) +
//      per-segment diagnostic logging; version bump forces reel regeneration.
// v5 = PRE_SECONDS 12→18 to absorb cumulative chunkStart drift from skipped
// v6 = POST_SECONDS 15→0 (clips end at button press, no trailing footage).
// v7 = (reverted) brief REACTION_TIME_CORRECTION_MS experiment.
// v8 = PRE_SECONDS 18→10, POST_SECONDS 0→2 (reverted — 10 s was too short).
// v9 = PRE_SECONDS back to 18, POST_SECONDS 2: 18 s lead-in absorbs reaction
//      lag; 2 s tail captures the play completing after the button press.
// v10 = orientation-aware reel clips: portrait proxy chunks now produce portrait
//       output instead of being forced into a landscape 1280×720 box.
export const GENERATOR_VERSION = 10;

// Version stamp for the compressed proxy video (videoProxyObjectPath).
// Bump when the proxy encoding changes in a way that requires a rebuild.
// v2 = audio transcoded to AAC (Opus-in-MP4 from WebM sources doesn't play
// on iOS Safari) — also used in the GCS chunk cache key so stale chunks
// encoded under the old settings are never mixed into a new proxy.
// v3 = added -force_key_frames "expr:gte(t,n_forced*2)" — REVERTED: the
// per-frame expression evaluation reduced encoding speed from ~5× to ~0.3×
// real-time on this server (33 min to encode a 6-min chunk), making the
// proxy build take ~3.5 h and blow past the 90-min highlight timeout.
// v4 = use frame-count flags (-g 60 -keyint_min 60 -sc_threshold 0) instead.
// Same ≤ 2 s drift guarantee at 30 fps (≤ 1 s at 60 fps) with no per-frame
// overhead — encoding speed stays at the ultrafast-preset baseline (~5× rt).
// v5 = orientation-aware scale: portrait sources use 720×1280 instead of being
//      squashed into 1280×720 with embedded black bars that make the clip tiny.
export const PROXY_VERSION = 6;

export const MAX_PROXY_BUILD_DURATION_SEC = 900; // 15 minutes
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
// 30 minutes per process. Clip encodes from the 720p proxy finish in seconds
// under normal conditions, but production GCS chunk downloads can be very slow
// (~80 KB/s observed), making a single 278 MB chunk take ~60 min end-to-end.
// The 30-min ceiling keeps the process from hanging forever while giving slow
// prod networks enough room to complete a chunk download + clip encode without
// tripping the timeout and triggering the raw-source fallback (see below).
// 90 min covers the worst-case GCS download throttle observed in prod:
// chunk 4 (242 MB) came in at ~150 KB/s = ~27 min just for that chunk.
// HARD_STALE_MS in the route files must be kept ≥ this value.
const PROCESS_TIMEOUT_MS = 90 * 60 * 1000;
// Stall detection: if no bytes arrive within this window, abort the download.
const DOWNLOAD_STALL_MS = 60 * 1000; // 60 seconds of no data = stalled
// Maximum source video size we'll attempt to process.
// The real rendering limit is container disk/memory, not file size per se.
// The default is generous — the actual crash was caused by oversized ffprobe
// buffer flags (probesize=2GB), not the video itself. Those are now fixed.
const MAX_SOURCE_VIDEO_MB = Number(process.env["MAX_SOURCE_VIDEO_MB"] ?? 6000);

// Parallel range download settings.
// GCS throttles each stream independently after an initial burst (~4 MB/s
// start → drops to ~0.24 MB/s).  Using N parallel range streams resets the
// burst window for each range, achieving N× the sustained throughput.
// Each range is 64 MB so a 1.4 GB file uses ~22 ranges processed 4 at a time.
const PARALLEL_DOWNLOAD_CONCURRENCY = 4;
const PARALLEL_RANGE_BYTES = 64 * 1024 * 1024; // 64 MB per range
// Use parallel download for files above this size (small files stay single-stream).
const PARALLEL_DOWNLOAD_THRESHOLD_BYTES = 200 * 1024 * 1024; // 200 MB

/**
 * Download a single byte range from a GCS file object to the correct offset
 * in a pre-allocated local file.  Uses a per-range stall timer so a hung
 * connection is detected quickly even when the overall job has a long timeout.
 */
const DOWNLOAD_RANGE_MAX_RETRIES = 4; // resume up to 4 times per range before giving up

async function downloadRange(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  objectFile: any,
  destPath: string,
  start: number,
  end: number,
  signal?: AbortSignal,
): Promise<number> {
  const rangeSize = end - start + 1;
  let totalBytesReceived = 0; // bytes written so far across all attempts

  for (let attempt = 0; attempt <= DOWNLOAD_RANGE_MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw new HighlightError("Download cancelled");

    // Resume from wherever the previous attempt left off.
    const resumeStart = start + totalBytesReceived;

    // Backoff before retry (not before the first attempt).
    if (attempt > 0) {
      const backoffMs = Math.min(5_000 * attempt, 20_000);
      logger.warn(
        { attempt, resumeStart, totalBytesReceived, rangeSize, backoffMs },
        "Range download stalled — retrying after backoff",
      );
      await new Promise((r) => setTimeout(r, backoffMs));
      if (signal?.aborted) throw new HighlightError("Download cancelled");
    }

    const ac = new AbortController();
    signal?.addEventListener("abort", () => ac.abort(), { once: true });

    let stallTimer = setTimeout(() => ac.abort(), DOWNLOAD_STALL_MS);
    const resetStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => ac.abort(), DOWNLOAD_STALL_MS);
    };

    let bytesThisAttempt = 0;
    const readStream = objectFile.createReadStream({ start: resumeStart, end });
    readStream.on("data", (chunk: Buffer) => {
      bytesThisAttempt += chunk.length;
      resetStall();
    });

    try {
      // Write directly into the pre-allocated file at the correct offset.
      await pipeline(
        readStream,
        createWriteStream(destPath, { start: resumeStart, flags: "r+" }),
        { signal: ac.signal },
      );
      totalBytesReceived += bytesThisAttempt;
      return totalBytesReceived;
    } catch (err: unknown) {
      totalBytesReceived += bytesThisAttempt;
      clearTimeout(stallTimer);

      const isStall = err instanceof Error && err.name === "AbortError" && !signal?.aborted;
      if (!isStall) {
        // Not a stall (cancelled, or a real stream error) — propagate immediately.
        throw err;
      }

      if (attempt === DOWNLOAD_RANGE_MAX_RETRIES) {
        throw new HighlightError(
          `Video range download stalled at byte ${start.toLocaleString()} ` +
          `(received ${totalBytesReceived.toLocaleString()} of ${rangeSize.toLocaleString()} bytes after ${attempt + 1} attempts). ` +
          `The stored video may be corrupted or truncated.`
        );
      }
      // Loop around for retry.
      continue;
    } finally {
      clearTimeout(stallTimer);
    }
  }

  // Should be unreachable, but TypeScript needs it.
  throw new HighlightError("downloadRange: exhausted retries unexpectedly");
}

/**
 * Download a source video from object storage to a local temp file.
 *
 * For files ≥ PARALLEL_DOWNLOAD_THRESHOLD_BYTES: uses parallel byte-range
 * downloads (PARALLEL_DOWNLOAD_CONCURRENCY concurrent streams).  GCS throttles
 * each TCP stream independently after an initial burst — parallel ranges get
 * independent burst windows and combined throughput is N× the single-stream
 * sustained rate.
 *
 * For smaller files: falls back to the simpler single-stream path.
 *
 * Uses the GCS SDK streaming API (file.createReadStream) to avoid signed URLs,
 * which fail on range requests in production (IO error: End of file).
 */
async function downloadSourceVideo(objectPath: string, destPath: string, signal?: AbortSignal): Promise<void> {
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

  const startTime = Date.now();

  if (fileSizeBytes >= PARALLEL_DOWNLOAD_THRESHOLD_BYTES) {
    // --- Parallel range download path ---
    const totalRanges = Math.ceil(fileSizeBytes / PARALLEL_RANGE_BYTES);
    logger.info(
      { fileSizeBytes, totalRanges, concurrency: PARALLEL_DOWNLOAD_CONCURRENCY },
      "Source video: starting parallel range download",
    );

    // Pre-allocate the file at full size so offset writes don't leave gaps.
    await fs.writeFile(destPath, Buffer.alloc(0));
    await fs.truncate(destPath, fileSizeBytes);

    let completedRanges = 0;
    const progressInterval = setInterval(() => {
      const pct = ((completedRanges / totalRanges) * 100).toFixed(0);
      logger.info(
        { completedRanges, totalRanges, pct, elapsedSec: Math.round((Date.now() - startTime) / 1000) },
        "Parallel source download progress",
      );
    }, 30_000);

    try {
      for (let base = 0; base < totalRanges; base += PARALLEL_DOWNLOAD_CONCURRENCY) {
        if (signal?.aborted) throw new HighlightError("Download cancelled");

        const batchSize = Math.min(PARALLEL_DOWNLOAD_CONCURRENCY, totalRanges - base);
        await Promise.all(
          Array.from({ length: batchSize }, async (_, offset) => {
            const rangeIdx = base + offset;
            const rangeStart = rangeIdx * PARALLEL_RANGE_BYTES;
            const rangeEnd = Math.min(rangeStart + PARALLEL_RANGE_BYTES - 1, fileSizeBytes - 1);
            await downloadRange(objectFile, destPath, rangeStart, rangeEnd, signal);
            completedRanges++;
          }),
        );
      }
      const elapsedSec = (Date.now() - startTime) / 1000;
      const mbps = (fileSizeMB / elapsedSec).toFixed(1);
      logger.info({ fileSizeBytes, elapsedSec: Math.round(elapsedSec), mbps }, "Source video parallel download complete");
    } finally {
      clearInterval(progressInterval);
    }
    return;
  }

  // --- Single-stream path (small files) ---
  let bytesReceived = 0;
  let lastByteTime = Date.now();

  const ac = new AbortController();
  // Hook external cancel signal — fires immediately if the job was cancelled.
  signal?.addEventListener("abort", () => ac.abort(), { once: true });

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
  signal?: AbortSignal,
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
        .then(() => downloadSourceVideo(objectPath, destPath, signal))
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
// On first use: transcodes source → proxy in CHUNKS (each chunk uploaded to
// GCS immediately). If the server restarts mid-transcode, already-uploaded
// chunks are reused and only missing chunks are re-encoded — at most one
// chunk's worth of work is lost per restart.
// On restart / subsequent attempts: downloads the existing ~700 MB proxy from
// GCS instead of re-downloading the 2.8 GB source.
//
// Both highlight and lowlight for the same game share one proxy (ref-counted,
// just like sourceVideoCache). Cache key is the game id.
// ---------------------------------------------------------------------------

// Duration of each proxy chunk in seconds. Each chunk takes roughly this many
// minutes to transcode at real-time speed, then is uploaded to GCS immediately.
// A server restart loses at most PROXY_CHUNK_DURATION_SEC of progress.
export const PROXY_CHUNK_DURATION_SEC = 360; // 6 minutes

/**
 * Quick duration probe for a source video. Used to determine how many chunks
 * to split the proxy transcode into. Accuracy to ±10% is sufficient.
 */
async function probeVideoDurationForChunking(
  srcPath: string,
  fileSizeBytes: number = 0,
  durationHintMs: number | null = null,
): Promise<number> {
  // Prefer the duration already probed from the container bytes (WebM last
  // cluster timecode / MP4 mvhd) and stored on the game row. Live-recorded
  // WebM is cueless, so ffprobe often finds no duration and falls through to
  // a bitrate guess that can be wildly wrong (e.g. 4x the real length).
  if (durationHintMs != null && durationHintMs > 0) return durationHintMs / 1000;

  const fast = await ffprobe([
    "-v", "error",
    "-analyzeduration", "10000000",
    "-probesize", "10000000",
    "-show_entries", "format=duration",
    "-of", "default=nw=1:nk=1",
    srcPath,
  ]).catch(() => "");
  let dur = parseFloat(fast);
  if (Number.isFinite(dur) && dur > 0) return dur;

  const deep = await ffprobe([
    "-v", "error",
    "-analyzeduration", "150000000",
    "-probesize", "150000000",
    "-show_entries", "format=duration",
    "-of", "default=nw=1:nk=1",
    srcPath,
  ]).catch(() => "");
  dur = parseFloat(deep);
  if (Number.isFinite(dur) && dur > 0) return dur;

  // Fallback: file size ÷ 3 Mbps (conservative estimate for ultrafast CRF28).
  // For URL inputs, use the passed-in fileSizeBytes instead of fs.stat.
  if (fileSizeBytes > 0) return fileSizeBytes / (3_000_000 / 8);
  if (!srcPath.startsWith("http")) {
    const stat = await fs.stat(srcPath);
    return stat.size / (3_000_000 / 8);
  }
  return 7200; // 2-hr default for URL sources when size is unknown
}

/**
 * Encode missing proxy chunks from srcPath and upload each one to GCS as
 * soon as ffmpeg closes it (restart-resilient: a platform restart loses at
 * most the chunk in flight). Returns the ACTUAL number of chunks that now
 * exist in GCS (pre-existing prefix + newly produced) — the duration-based
 * estimate can be wrong in either direction.
 *
 * When deleteAfterUpload is set, each local chunk file is removed right
 * after its GCS upload so peak tmpfs usage stays at ~source + one chunk.
 * (/tmp is RAM-backed in the production container — every temp byte counts
 * against the ~2 GB memory budget.)
 */
/**
 * Probe the actual duration of a locally-written segment file using ffprobe.
 * Returns the duration in seconds, or 0 on any error (caller should fall back
 * to PROXY_CHUNK_DURATION_SEC).  Uses a small probesize so it only reads the
 * moov atom — fast even for large MP4 segments.
 */
async function probeSegmentDurationSec(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("ffprobe", [
      "-v", "error",
      "-analyzeduration", "500000000",
      "-probesize",       "500000000",
      "-show_entries",    "format=duration",
      "-of",              "default=nw=1:nk=1",
      filePath,
    ]);
    let out = "";
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    child.on("close", () => {
      const dur = parseFloat(out.trim());
      resolve(Number.isFinite(dur) && dur > 0 ? dur : 0);
    });
    child.on("error", () => resolve(0));
  });
}

async function encodeChunksToGcs(
  gameId: number,
  ownerId: number,
  srcPath: string,
  workDir: string,
  existFlags: boolean[],
  firstMissing: number,
  deleteAfterUpload: boolean,
  signal?: AbortSignal,
  /** Stop encoding after this many seconds from the start of the file.
   * Only the chunks needed for the reel are built; the rest remain absent in
   * GCS and will be built lazily (by a background proxy build or next request).
   * Omit (or pass undefined) to encode the full video as before. */
  maxDurationSec?: number,
): Promise<{ actualNumChunks: number; segmentDurationsSec: number[] }> {
  const numChunks = existFlags.length;
  const gcsChunkPath = (i: number) =>
    `/objects/uploads/${ownerId}/proxy_chunk_v${PROXY_VERSION}_${gameId}_${i}`;
  const startSec = firstMissing * PROXY_CHUNK_DURATION_SEC;

  // When maxDurationSec is set (targeted reel generation), cap the encode at
  // that point in the file.  Add one extra chunk of headroom so that the last
  // needed segment (which may span a chunk boundary) is always fully covered.
  // For full-game proxy builds (maxDurationSec undefined) there is no cap.
  const encodeLimitSec =
    maxDurationSec != null && maxDurationSec > startSec
      ? maxDurationSec - startSec + PROXY_CHUNK_DURATION_SEC
      : null;

  logger.info(
    { gameId, numChunks, firstMissing, startSec, encodeLimitSec },
    "Proxy: single-pass segment encode with incremental GCS upload",
  );

  const segmentPattern = path.join(workDir, "proxy_chunk_%05d.mp4");
  const segmentListPath = path.join(workDir, "segments.txt");
  await fs.unlink(segmentListPath).catch(() => {}); // clear stale list from prior run

  // For HTTP/HTTPS sources (GCS signed URLs), range requests are unreliable
  // in production.  Place -ss AFTER -i so ffmpeg decodes-and-discards rather
  // than issuing a mid-file Range: bytes= request.  For local file inputs,
  // keep the fast pre-input seek (lseek is O(1) on disk).
  const isUrlSource = srcPath.startsWith("http");
  const ffmpegArgs = [
    "-y",
    ...((!isUrlSource && firstMissing > 0) ? ["-ss", String(startSec)] : []),
    "-i", srcPath,
    // Slow (decode-and-discard) seek for URL sources — avoids range requests.
    ...((isUrlSource && firstMissing > 0) ? ["-ss", String(startSec)] : []),
    // Stop encoding early when only a subset of chunks is needed (reel-targeted
    // build).  Full-game builds (encodeLimitSec === null) have no -t flag.
    ...(encodeLimitSec != null ? ["-t", String(Math.ceil(encodeLimitSec))] : []),
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", "33",
    // Fix keyframe interval at 60 frames so the segment muxer's chunk
    // boundaries land within ≤ 60 frames (≤ 2 s at 30 fps, ≤ 1 s at 60 fps)
    // of the nominal PROXY_CHUNK_DURATION_SEC.  Without this, libx264 ultrafast
    // uses the default 250-frame GOP (≈ 8 s at 30 fps), so each chunk can lag
    // the nominal by up to 8 s — 3 skipped chunks × 8 s = 24 s of cumulative
    // chunkStart error, stripping the entire PRE_SECONDS lead-in window.
    //
    // Using frame-count flags (-g/-keyint_min) rather than the timestamp
    // expression (-force_key_frames "expr:...") is critical for speed: the
    // expression is evaluated per frame and reduced encoding from ~5× to
    // ~0.3× real-time on this server (33 min to encode a 6-min chunk).
    "-g", "60",
    "-keyint_min", "60",
    "-sc_threshold", "0",
    // Orientation-aware scale: portrait sources (iw < ih, after ffmpeg's default
    // autorotate applies the iOS rotation tag) target 720×1280 so the content
    // fills the frame; landscape sources keep the original 1280×720 target.
    // force_original_aspect_ratio=decrease fits the source within the target box
    // and pad fills any remaining space with black so the output is always the
    // exact target dimensions (required for consistent segment muxing).
    "-vf",
      `scale='if(gte(iw,ih),${OUTPUT_WIDTH},${OUTPUT_HEIGHT})':'if(gte(iw,ih),${OUTPUT_HEIGHT},${OUTPUT_WIDTH})':force_original_aspect_ratio=decrease,` +
      `pad='if(gte(iw,ih),${OUTPUT_WIDTH},${OUTPUT_HEIGHT})':'if(gte(iw,ih),${OUTPUT_HEIGHT},${OUTPUT_WIDTH})':(ow-iw)/2:(oh-ih)/2`,
    // Always transcode audio to AAC. Live-recorded WebM sources carry Opus,
    // and Opus-in-MP4 does not play on iOS Safari — the proxy doubles as
    // the film-room playback file, so it must be universally playable.
    "-c:a", "aac",
    "-b:a", "128k",
    "-f", "segment",
    "-segment_time", String(PROXY_CHUNK_DURATION_SEC),
    // Start segment numbering at firstMissing so filenames match GCS keys.
    "-segment_start_number", String(firstMissing),
    "-reset_timestamps", "1",
    "-segment_list", segmentListPath,
    "-segment_list_type", "flat",
    segmentPattern,
  ];

  // ffmpegDone is set in .finally() so the upload loop knows the last
  // segment (whose entry appears in the list when ffmpeg opens it but is
  // only fully flushed when ffmpeg exits) is safe to upload.
  let ffmpegDone = false;
  const ffmpegPromise = runFfmpegQueued(ffmpegArgs, 90 * 60 * 1000).finally(
    () => { ffmpegDone = true; },
  );

  // Incremental upload loop, driven by the segments ffmpeg ACTUALLY writes
  // (the duration probe is only an estimate — the source can turn out
  // shorter or longer, so the estimate must never gate loop exit).
  // ffmpeg appends chunk N's filename to segments.txt when it OPENS chunk N.
  // Chunk N is fully written (safe to upload) only after chunk N+1 is opened
  // (i.e., lines[N+1] exists) or ffmpeg has exited.
  let producedSegments = 0;
  let discardedTrailingStubs = 0;
  // Per-segment durations probed from the local file before deletion.
  // Indexed by nextLocalIdx (0 = firstMissing chunk), so the full sequence
  // requires prepending PROXY_CHUNK_DURATION_SEC × firstMissing approximations
  // for chunks that were already in GCS before this encode run.
  const segmentDurationsSec: number[] = [];
  const uploadLoop = async (): Promise<void> => {
    let nextLocalIdx = 0; // 0 = firstMissing, 1 = firstMissing+1, …

    while (true) {
      await new Promise<void>((r) => setTimeout(r, 2000));

      // Capture the done flag BEFORE reading the list so the list is always
      // at least as fresh as the flag (no missed final segment).
      const doneAtRead = ffmpegDone;
      const content = await fs.readFile(segmentListPath, "utf-8").catch(() => "");
      const lines = content.trim().split("\n").filter(Boolean);
      producedSegments = lines.length;

      while (nextLocalIdx < lines.length) {
        const safe = (nextLocalIdx + 1 < lines.length) || doneAtRead;
        if (!safe) break; // wait for ffmpeg to move past this chunk

        const chunkIdx = firstMissing + nextLocalIdx;
        const localPath = path.join(workDir, lines[nextLocalIdx]);

        // ffmpeg's segment muxer can emit a final stub segment (moov atom
        // only, ~260 bytes) when the source ends exactly on a segment
        // boundary. Never upload it — an unplayable chunk in GCS poisons
        // every future existence probe for this game.
        const isFinalSegment = doneAtRead && nextLocalIdx === lines.length - 1;
        if (isFinalSegment && chunkIdx > 0) {
          const size = await fs.stat(localPath).then((s) => s.size).catch(() => 0);
          if (size < MIN_VALID_CHUNK_BYTES) {
            logger.warn(
              { gameId, chunk: chunkIdx, size },
              "Proxy chunk: discarding empty trailing stub segment",
            );
            await fs.unlink(localPath).catch(() => {});
            discardedTrailingStubs = 1;
            nextLocalIdx++;
            continue;
          }
        }
        if (!existFlags[chunkIdx]) {
          if (signal?.aborted) throw new HighlightError("Cancelled");
          logger.info({ gameId, chunk: chunkIdx, numChunks }, "Proxy chunk: uploading to GCS");
          await objectStorageService.uploadLocalFileToObjectPath(
            localPath, gcsChunkPath(chunkIdx), "video/mp4",
          );
          logger.info({ gameId, chunk: chunkIdx, numChunks }, "Proxy chunk: saved to GCS");
        } else {
          logger.info({ gameId, chunk: chunkIdx }, "Proxy chunk: already in GCS, skipping");
        }
        // Probe the actual segment duration BEFORE deletion so the HLS
        // sentinel can store exact EXTINF values (no post-hoc GCS re-download).
        const segDur = await probeSegmentDurationSec(localPath);
        segmentDurationsSec.push(segDur > 0 ? segDur : PROXY_CHUNK_DURATION_SEC);
        if (deleteAfterUpload) {
          await fs.unlink(localPath).catch(() => {});
        }
        nextLocalIdx++;
      }

      if (doneAtRead && nextLocalIdx >= lines.length) break;
    }
  };

  await Promise.all([ffmpegPromise, uploadLoop()]);

  // The REAL chunk count comes from what ffmpeg produced, not the estimate.
  // producedSegments === 0 with firstMissing > 0 means the resume seek was
  // past the true end of footage (duration was overestimated on a prior
  // run) — the chunks already in GCS are the complete set.
  const actualNumChunks = firstMissing + producedSegments - discardedTrailingStubs;
  if (actualNumChunks === 0) {
    throw new HighlightError("Proxy encode produced no output — source video appears empty or unreadable");
  }
  if (actualNumChunks !== numChunks) {
    logger.warn(
      { gameId, estimatedChunks: numChunks, actualChunks: actualNumChunks },
      "Proxy: duration estimate was off — using actual chunk count",
    );
  }
  return { actualNumChunks, segmentDurationsSec };
}

/**
 * Transcode srcPath → destPath in restart-resilient chunks.
 *
 * Chunks are uploaded to GCS incrementally as ffmpeg finishes each one,
 * so a platform restart (Replit cycles instances every ~8 min) only loses
 * the last 1-2 chunks that hadn't been uploaded yet.  On the next boot,
 * firstMissing is computed from the GCS existence check and ffmpeg resumes
 * from that point (one seek, not 22).
 */
async function createChunkedProxy(
  gameId: number,
  ownerId: number,
  srcPath: string,
  destPath: string,
  fileSizeBytes: number = 0,
  durationHintMs: number | null = null,
  signal?: AbortSignal,
): Promise<void> {
  const proxyTmpDir = path.dirname(destPath);
  const duration = await probeVideoDurationForChunking(srcPath, fileSizeBytes, durationHintMs);
  // numChunks is an ESTIMATE — the source may be shorter or longer than the
  // probe says. The encode below is driven by the segments ffmpeg actually
  // produces, so a wrong estimate only affects resume bookkeeping.
  const numChunks = Math.max(1, Math.ceil(duration / PROXY_CHUNK_DURATION_SEC));

  logger.info(
    { gameId, durationSec: duration.toFixed(0), numChunks },
    "Proxy: creating in restart-resilient chunks",
  );

  // Chunk cache key includes PROXY_VERSION so chunks encoded under older
  // settings (e.g. Opus audio passthrough) are never mixed into a new proxy.
  const gcsChunkPath = (i: number) =>
    `/objects/uploads/${ownerId}/proxy_chunk_v${PROXY_VERSION}_${gameId}_${i}`;
  const gcsChunkPaths = Array.from({ length: numChunks }, (_, i) => gcsChunkPath(i));
  const existFlags = await Promise.all(
    gcsChunkPaths.map((p) => proxyChunkExistsInGcs(p)),
  );
  const allInGcs = existFlags.every(Boolean);

  // Local filename for chunk i — consistent across all paths.
  const chunkLocalPath = (i: number) =>
    path.join(proxyTmpDir, `proxy_chunk_${String(i).padStart(5, "0")}.mp4`);

  const chunkLocalPaths: string[] = [];

  if (allInGcs) {
    // Fast path: download all already-encoded chunks from GCS.
    logger.info({ gameId, numChunks }, "Proxy: all chunks in GCS — downloading");
    for (let i = 0; i < numChunks; i++) {
      await downloadSourceVideo(gcsChunkPaths[i], chunkLocalPath(i), signal);
      chunkLocalPaths.push(chunkLocalPath(i));
    }
  } else {
    // Partial or no chunks in GCS — encode the missing ones (single-pass
    // segment encode with incremental GCS upload; see encodeChunksToGcs).
    // Local chunk files are KEPT here because the concat below needs them.
    const firstMissing = existFlags.findIndex((e) => !e);
    const { actualNumChunks } = await encodeChunksToGcs(
      gameId, ownerId, srcPath, proxyTmpDir, existFlags, firstMissing, false, signal,
    );

    // Chunks 0..firstMissing-1 were already in GCS — download them for concat.
    for (let i = 0; i < firstMissing; i++) {
      logger.info({ gameId, chunk: i }, "Proxy chunk: downloading GCS chunk for concat");
      await downloadSourceVideo(gcsChunkPaths[i], chunkLocalPath(i));
    }
    // Chunks firstMissing..actualNumChunks-1 were just encoded and are already on disk.
    for (let i = 0; i < actualNumChunks; i++) {
      chunkLocalPaths.push(chunkLocalPath(i));
    }
  }

  if (chunkLocalPaths.length === 1) {
    await fs.rename(chunkLocalPaths[0], destPath);
  } else {
    const concatListPath = path.join(proxyTmpDir, "proxy_concat.txt");
    await fs.writeFile(
      concatListPath,
      chunkLocalPaths.map((p) => `file '${p}'`).join("\n"),
    );
    logger.info({ gameId, numChunks: chunkLocalPaths.length }, "Proxy: concatenating chunks");
    await runFfmpegQueued(
      [
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", concatListPath,
        "-c", "copy",
        // No +faststart — the local proxy is only used by ffmpeg (which
        // handles end-of-file moov fine on a local disk).  +faststart
        // writes a full second copy of the output file before rearranging
        // the moov atom, adding ~1.4 GB of peak disk usage that has been
        // causing OOM crashes in production.  The GCS-uploaded proxy for
        // film-room playback uses a separate faststart pass.
        destPath,
      ],
      10 * 60 * 1000,
    );
    for (const p of chunkLocalPaths) {
      await fs.unlink(p).catch(() => {});
    }
  }
}

// Chunks smaller than this are unplayable stubs — ffmpeg's segment muxer can
// emit a final MP4 containing only a moov atom (~260 bytes) when the source
// ends exactly at a segment boundary, and older encoder versions uploaded
// them. Treat such objects as missing so they are re-encoded or ignored
// rather than fed to ffmpeg as inputs.
const MIN_VALID_CHUNK_BYTES = 10_000;

/** Existence probe for proxy chunks that also rejects tiny stub objects. */
async function proxyChunkExistsInGcs(objectPath: string): Promise<boolean> {
  try {
    const file = await objectStorageService.getObjectEntityFile(objectPath);
    const [md] = await file.getMetadata();
    return Number(md.size ?? 0) >= MIN_VALID_CHUNK_BYTES;
  } catch {
    return false;
  }
}

/**
 * Canonical GCS path for a proxy chunk for a given game and chunk index.
 * Uses the same naming convention as the rest of the proxy chunk machinery.
 */
export function makeProxyChunkGcsPath(ownerId: number, gameId: number, chunkIndex: number): string {
  return `/objects/uploads/${ownerId}/proxy_chunk_v${PROXY_VERSION}_${gameId}_${chunkIndex}`;
}
const chunkEnsureInFlight = new Map<string, Promise<string[]>>();

/**
 * Ensure every proxy chunk for a game exists in GCS and return their object
 * paths in playback order. NEVER builds the concatenated full proxy — reel
 * extraction works directly from individual ~250 MB chunks, so peak tmpfs
 * usage (RAM-backed in production) stays bounded regardless of game length.
 * The old download-all-then-concat path needed ~2x the full proxy size in
 * /tmp and was OOM-killed every time on long games.
 */
function ensureProxyChunksInGcs(
  gameId: number,
  ownerId: number,
  game: { videoObjectPath: string | null; videoDurationMs: number | null },
  signal?: AbortSignal,
  /** Only build proxy chunks up to this index (inclusive). Callers that know
   * the last chunk they need pass this so the encoder stops early rather than
   * transcoding the entire game. Omit for full-game builds. */
  maxChunkNeeded?: number,
): Promise<string[]> {
  const key = `${gameId}:${maxChunkNeeded ?? "all"}`;
  const inFlight = chunkEnsureInFlight.get(key);
  if (inFlight) return inFlight;
  const p = doEnsureProxyChunksInGcs(gameId, ownerId, game, signal, maxChunkNeeded).finally(() => {
    chunkEnsureInFlight.delete(key);
  });
  chunkEnsureInFlight.set(key, p);
  return p;
}

async function doEnsureProxyChunksInGcs(
  gameId: number,
  ownerId: number,
  game: { videoObjectPath: string | null; videoDurationMs: number | null },
  signal?: AbortSignal,
  maxChunkNeeded?: number,
): Promise<string[]> {
  const durationMs = game.videoDurationMs ?? 0;
  if (durationMs <= 0) {
    throw new HighlightError("Video duration unknown — cannot use chunk-based extraction");
  }
  const gcsChunkPath = (i: number) =>
    `/objects/uploads/${ownerId}/proxy_chunk_v${PROXY_VERSION}_${gameId}_${i}`;
  const numChunksGuess = Math.max(1, Math.ceil(durationMs / 1000 / PROXY_CHUNK_DURATION_SEC));

  // Always probe the full estimated range in parallel.  A targeted build
  // (maxChunkNeeded set) only ENCODES a subset, but the returned path array
  // must always cover the complete proxy so renderGameSegments can correctly
  // identify the real last chunk and handle spansNextChunk detection.  Probing
  // all numChunksGuess indices in Promise.all costs ~200 ms regardless of
  // count — not a bottleneck.
  const existFlags = await Promise.all(
    Array.from({ length: numChunksGuess }, (_, i) =>
      proxyChunkExistsInGcs(gcsChunkPath(i)),
    ),
  );

  if (existFlags.every(Boolean)) {
    // Probe past the estimate to discover the TRUE chunk count (the duration-
    // based guess can undercount when the actual encode produced more segments
    // than estimated).
    let count = numChunksGuess;
    while (
      count < numChunksGuess + 50 &&
      (await proxyChunkExistsInGcs(gcsChunkPath(count)))
    ) {
      count++;
    }
    logger.info({ gameId, count, maxChunkNeeded }, "Proxy chunks: all present in GCS");
    return Array.from({ length: count }, (_, i) => gcsChunkPath(i));
  }

  if (!game.videoObjectPath) {
    throw new HighlightError("Game has no recorded video");
  }

  // Duration gate: building proxy chunks requires transcoding the full source
  // (libx264 re-encode of a VP8/WebM source). On the production container the
  // CPU throughput is roughly 0.35× real-time, so a 33-min game takes ~94 min
  // to transcode — exceeding PROCESS_TIMEOUT_MS and causing a stale timeout.
  //
  // For long videos, skip the inline proxy build and let the caller fall back
  // to parallel-download + direct source extraction (which now completes in
  // ~10–15 min thanks to the parallel range downloader).  The proxy path still
  // runs for shorter games where it finishes well within the timeout, and any
  // game whose chunks are ALREADY fully in GCS (existFlags.every(Boolean)) is
  // served from cache regardless of duration (handled above).
  //
  // EXCEPTION: when maxChunkNeeded is set, only a subset of chunks are built.
  // The effective encode duration is (maxChunkNeeded+1) * PROXY_CHUNK_DURATION_SEC
  // which is often well under the timeout even for long games.
  const MAX_INLINE_PROXY_DURATION_SEC = 1200; // 20 minutes (full-game limit)
  const durSec = durationMs / 1000;
  const effectiveDurSec =
    maxChunkNeeded != null
      ? Math.min(durSec, (maxChunkNeeded + 1) * PROXY_CHUNK_DURATION_SEC)
      : durSec;
  if (effectiveDurSec > MAX_INLINE_PROXY_DURATION_SEC) {
    throw new HighlightError(
      `Video is ${Math.round(durSec / 60)} min — too long for inline proxy build ` +
      `(limit ${MAX_INLINE_PROXY_DURATION_SEC / 60} min). Using direct source extraction.`,
    );
  }

  const firstMissing = existFlags.findIndex((e) => !e);
  // When the caller only needs a subset of chunks, tell the encoder to stop
  // after the last needed chunk. This prevents encoding the entire game when
  // all highlight moments are in the first few minutes.
  const maxDurationSec =
    maxChunkNeeded != null
      ? (maxChunkNeeded + 1) * PROXY_CHUNK_DURATION_SEC
      : undefined;
  logger.info(
    { gameId, numChunksGuess, firstMissing, maxDurationSec },
    "Proxy chunks: encoding missing chunks from source",
  );
  // Prefix starts with "video-proxy-" so startup orphan cleanup covers it.
  const workDir = path.join(
    os.tmpdir(),
    `video-proxy-enc-${gameId}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await fs.mkdir(workDir, { recursive: true });
  try {
    const { srcPath, release } = await acquireSourceVideo(game.videoObjectPath, signal);
    let actualNumChunks: number;
    try {
      // deleteAfterUpload: local chunk files are removed as soon as each one
      // is safely in GCS — extraction re-downloads only the chunks it needs.
      ({ actualNumChunks } = await encodeChunksToGcs(
        gameId, ownerId, srcPath, workDir, existFlags, firstMissing, true, signal, maxDurationSec,
      ));
    } finally {
      release();
    }
    return Array.from({ length: actualNumChunks }, (_, i) => gcsChunkPath(i));
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

const proxyLocalCache = new Map<number, SourceVideoEntry>();

async function acquireGameProxy(
  gameId: number,
  ownerId: number,
  signal?: AbortSignal,
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
          if (game?.videoProxyObjectPath && game.videoProxyVersion === PROXY_VERSION) {
            logger.info(
              { gameId, objectPath: game.videoProxyObjectPath },
              "Downloading existing proxy video",
            );
            await downloadSourceVideo(game.videoProxyObjectPath, destPath, signal);
            logger.info({ gameId }, "Proxy download complete");
            return destPath;
          }
          if (!game?.videoObjectPath) throw new HighlightError("Game has no recorded video");
          // Optimization: if all proxy chunks already exist in GCS we can skip
          // downloading the 1-2 GB source entirely and jump straight to the
          // chunk-download + concat path inside createChunkedProxy.  This
          // prevents the OOM crash loop that occurred when the server kept
          // restarting after downloading the source + all chunks concurrently.
          const durationMs = game.videoDurationMs ?? 0;
          const numChunksGuess = durationMs > 0
            ? Math.max(1, Math.ceil(durationMs / 1000 / PROXY_CHUNK_DURATION_SEC))
            : 0;
          const gcsChunkPath = (i: number) =>
            `/objects/uploads/${ownerId}/proxy_chunk_v${PROXY_VERSION}_${gameId}_${i}`;
          const allChunksPreExist = numChunksGuess > 0 && (
            await Promise.all(
              Array.from({ length: numChunksGuess }, (_, i) =>
                objectStorageService.checkObjectEntityExists(gcsChunkPath(i)),
              ),
            )
          ).every(Boolean);

          if (allChunksPreExist) {
            logger.info(
              { gameId, numChunksGuess },
              "Proxy: all GCS chunks pre-verified — skipping source download",
            );
            await createChunkedProxy(gameId, ownerId, "", destPath, 0, durationMs, signal);
          } else {
            // Download the source locally before encoding. Streaming the source
            // from a GCS signed URL is unreliable in production — mid-file reads
            // terminate with "End of file", killing the encode at open or on a
            // resume seek. The download is ref-counted and shared with any
            // concurrent reel job via sourceVideoCache, and local disk reads
            // also encode noticeably faster than network streaming.
            logger.info({ gameId }, "Creating proxy video (chunked) — downloading source locally");
            const { srcPath, release } = await acquireSourceVideo(game.videoObjectPath, signal);
            try {
              await createChunkedProxy(gameId, ownerId, srcPath, destPath, 0, game.videoDurationMs, signal);
            } finally {
              release();
            }
          }
          // Guard: check the game still exists before writing the proxy object
          // to GCS. If the game was deleted while we were building the proxy,
          // discard the output rather than creating an orphaned GCS object.
          {
            const stillExists = await db.query.gamesTable.findFirst({
              where: eq(gamesTable.id, gameId),
              columns: { id: true },
            });
            if (!stillExists) {
              logger.warn({ gameId }, "Proxy: game was deleted mid-build — discarding, not uploading to GCS");
              return destPath;
            }
          }
          logger.info({ gameId }, "Proxy created — uploading final proxy to storage");
          const proxyObjectPath = await uploadHighlight(destPath, ownerId);
          await db
            .update(gamesTable)
            .set({ videoProxyObjectPath: proxyObjectPath, videoProxyVersion: PROXY_VERSION })
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

// Fire-and-forget background proxy builds triggered from the film-room
// playback route. Guarded so each game only ever has one build in flight.
const backgroundProxyBuilds = new Set<number>();

/**
 * Build (or verify) the proxy for a game and return a Promise that resolves
 * when the build is done (or skipped). Unlike ensureGameProxyInBackground this
 * is awaitable, so callers can rate-limit a batch of builds.
 *
 * No-ops and resolves immediately if:
 *  - a build for this game is already in progress
 *  - a valid current-version proxy already exists in the DB
 *  - the video is too long for safe local concat (>15 min / 900 s)
 */
export async function buildGameProxyNow(
  gameId: number,
  ownerId: number,
): Promise<void> {
  if (backgroundProxyBuilds.has(gameId)) return;
  backgroundProxyBuilds.add(gameId);
  const proxyAc = new AbortController();
  proxyBuildAbortControllers.set(gameId, proxyAc);
  try {
    const game = await db.query.gamesTable.findFirst({
      where: eq(gamesTable.id, gameId),
    });
    if (!game?.videoObjectPath) return;
    if (game.videoProxyObjectPath && game.videoProxyVersion === PROXY_VERSION) return;
    const MAX_PROXY_BUILD_DURATION_SEC = 900;
    const durSec = (game.videoDurationMs ?? 0) / 1000;
    if (durSec <= 0 || durSec > MAX_PROXY_BUILD_DURATION_SEC) {
      logger.info(
        { gameId, durSec: Math.round(durSec) },
        "Proxy sweep: skipped — video too long (or duration unknown) for full local concat on tmpfs",
      );
      return;
    }
    if (proxyAc.signal.aborted) return;
    logger.info({ gameId }, "Proxy sweep: build starting");
    const { release } = await acquireGameProxy(gameId, ownerId, proxyAc.signal);
    release();
    logger.info({ gameId }, "Proxy sweep: build complete");
  } catch (err) {
    logger.error({ err, gameId }, "Proxy sweep: build failed");
  } finally {
    backgroundProxyBuilds.delete(gameId);
    proxyBuildAbortControllers.delete(gameId);
  }
}

/**
 * Ensure a current-version proxy MP4 exists for a game, building it in the
 * background if needed. Safe to call on every playback request: no-ops when
 * a valid proxy already exists in the DB or a build is already running.
 */
export function ensureGameProxyInBackground(gameId: number, ownerId: number): void {
  if (backgroundProxyBuilds.has(gameId)) return;
  backgroundProxyBuilds.add(gameId);
  const proxyAc = new AbortController();
  proxyBuildAbortControllers.set(gameId, proxyAc);
  (async () => {
    const game = await db.query.gamesTable.findFirst({
      where: eq(gamesTable.id, gameId),
    });
    if (!game?.videoObjectPath) return;
    if (game.videoProxyObjectPath && game.videoProxyVersion === PROXY_VERSION) return;
    // SIZE GATE: building the playback proxy ends with downloading every
    // chunk and concatenating them locally — on RAM-backed /tmp that peaks
    // at ~2x the full proxy size and OOM-kills the server for long games.
    // Short games (≤15 min ≈ ≤3 chunks) stay well within budget; longer
    // games skip the playback proxy and the film room streams the raw
    // source instead. (Reel generation never builds the full proxy at all —
    // it works chunk-by-chunk.)
    const durSec = (game.videoDurationMs ?? 0) / 1000;
    if (durSec <= 0 || durSec > MAX_PROXY_BUILD_DURATION_SEC) {
      logger.info(
        { gameId, durSec: Math.round(durSec) },
        "Background proxy build skipped — video too long (or duration unknown) for full local concat on tmpfs",
      );
      return;
    }
    if (proxyAc.signal.aborted) return;
    logger.info({ gameId }, "Background proxy build starting (film-room playback)");
    const { release } = await acquireGameProxy(gameId, ownerId, proxyAc.signal);
    // The build already uploaded the proxy to GCS and persisted the DB row;
    // we don't need the local file, so release it immediately.
    release();
    logger.info({ gameId }, "Background proxy build complete");
  })()
    .catch((err) => {
      logger.error({ err, gameId }, "Background proxy build failed");
    })
    .finally(() => {
      backgroundProxyBuilds.delete(gameId);
      proxyBuildAbortControllers.delete(gameId);
    });
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
  // nice -n 10: ffmpeg runs at reduced OS priority so Node's event loop
  // always preempts it for healthchecks/API calls, but ffmpeg still gets
  // plenty of CPU between requests. -n 19 was too aggressive — the download
  // process starved ffmpeg so badly that encoding took >20 min per chunk.
  return prev.then(() => run("nice", ["-n", "10", "ffmpeg", ...args], timeoutMs)).finally(unlock);
}

// Module-level reel-generation serializer.
// Prevents two concurrent reel jobs (e.g. highlight + lowlight kicked off at
// the same time) from downloading different proxy chunks simultaneously.
// Each chunk is ~250 MB in RAM-backed /tmp — two jobs can peak at 4 chunks
// (~1 GB) at once, which OOM-kills the production container and triggers
// healthcheck restarts that kill the jobs mid-encode.  Serialising the heavy
// phase (chunk download + extract + encode + upload) keeps peak usage ≤
// 2 chunks (~550 MB) at all times.
// The ffmpeg queue above serialises the CPU-bound encode step; this queue
// additionally serialises the I/O-bound download step.
let _reelGenerationTail: Promise<void> = Promise.resolve();

function _acquireReelSlot(): [Promise<void>, () => void] {
  let release!: () => void;
  const mySlot = new Promise<void>((r) => { release = r; });
  const prev = _reelGenerationTail;
  _reelGenerationTail = mySlot;
  return [prev, release];
}

// Boot-time cleanup: remove stale reel temp dirs and chunk files left behind
// by previous server processes that were OOM-killed (SIGKILL) before their
// finally blocks could run.  /tmp is RAM-backed (tmpfs) and persists across
// Node.js process restarts within the same container — without this, stale
// files from each failed run accumulate in /tmp, consuming RAM and eventually
// causing the next run to also OOM, creating a death spiral.
//
// Patterns cleaned:
//   hl-*   — highlight tmpDirs (mkdtemp prefix)
//   ll-*   — lowlight tmpDirs
//   shpchunk_*  — shared proxy chunk cache files
//   xchunk_*    — cross-chunk concat list fragments (rare leaks)
(async () => {
  try {
    const tmpdir = os.tmpdir();
    const entries = await fs.readdir(tmpdir).catch(() => [] as string[]);
    let cleaned = 0;
    for (const entry of entries) {
      if (/^(hl|ll)-/.test(entry) || /^(shpchunk|xchunk)_/.test(entry)) {
        await fs.rm(path.join(tmpdir, entry), { recursive: true, force: true }).catch(() => {});
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.info({ cleaned }, "Boot: removed stale reel tmpfs files from previous run");
    }
  } catch {
    // Non-fatal
  }
})();

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
    .set({
      highlightStatus: status,
      // Stamp the generator version on completion so stale reels (built by
      // older clip-timing code) can be detected and invalidated on read.
      ...(status === "ready" ? { highlightGeneratorVersion: GENERATOR_VERSION } : {}),
      ...extra,
    })
    .where(eq(gamesTable.id, gameId));
}

async function setGameLowlightStatus(
  gameId: number,
  status: "processing" | "ready" | "failed",
  extra: { lowlightObjectPath?: string | null; lowlightError?: string | null } = {},
): Promise<void> {
  await db
    .update(gamesTable)
    .set({
      lowlightStatus: status,
      ...(status === "ready" ? { lowlightGeneratorVersion: GENERATOR_VERSION } : {}),
      ...extra,
    })
    .where(eq(gamesTable.id, gameId));
}

async function setTeamStatus(
  teamId: number,
  status: "processing" | "ready" | "failed",
  extra: { highlightObjectPath?: string | null; highlightError?: string | null } = {},
): Promise<void> {
  await db
    .update(teamsTable)
    .set({
      highlightStatus: status,
      ...(status === "ready" ? { highlightGeneratorVersion: GENERATOR_VERSION } : {}),
      ...extra,
    })
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
 * True when the event's timestamp maps to a position inside the recorded
 * footage. Mirrors the mapping used by buildSegments (offset + halftime gap).
 */
function isTimestampOnFilm(
  ts: number,
  game: {
    videoDurationMs: number | null;
    videoOffsetMs: number | null;
    videoHalf2StartMs: number | null;
    videoHalftimeGapMs: number | null;
  },
): boolean {
  const gapAdj =
    game.videoHalf2StartMs != null &&
    game.videoHalftimeGapMs != null &&
    ts >= game.videoHalf2StartMs
      ? game.videoHalftimeGapMs
      : 0;
  const adjustedMs = ts - (game.videoOffsetMs ?? 0) - gapAdj;
  return adjustedMs >= 0 && adjustedMs < (game.videoDurationMs ?? 0);
}

/**
 * Eligible-vs-on-film coverage for a game's highlight moments.
 * onFilmMoments is null when the video's true duration is unknown.
 */
export async function getHighlightCoverage(game: {
  id: number;
  videoDurationMs: number | null;
  videoOffsetMs: number | null;
  videoHalf2StartMs: number | null;
  videoHalftimeGapMs: number | null;
}): Promise<{ eligibleMoments: number; onFilmMoments: number | null }> {
  const events = await db.query.gameEventsTable.findMany({
    where: eq(gameEventsTable.gameId, game.id),
  });
  const eligible = events.filter((e) => e.delta > 0 && HIGHLIGHT_FIELDS.has(e.statField));
  const onFilmMoments =
    game.videoDurationMs != null && game.videoDurationMs > 0
      ? eligible.filter((e) => isTimestampOnFilm(e.videoTimestampMs ?? 0, game)).length
      : null;
  return { eligibleMoments: eligible.length, onFilmMoments };
}

/**
 * Eligible-vs-on-film coverage for a game's lowlight moments.
 */
export async function getLowlightCoverage(game: {
  id: number;
  videoDurationMs: number | null;
  videoOffsetMs: number | null;
  videoHalf2StartMs: number | null;
  videoHalftimeGapMs: number | null;
}): Promise<{ eligibleMoments: number; onFilmMoments: number | null }> {
  const events = await db.query.gameEventsTable.findMany({
    where: eq(gameEventsTable.gameId, game.id),
  });
  const eligible = events.filter((e) => isTrueLowlight(e, events));
  const onFilmMoments =
    game.videoDurationMs != null && game.videoDurationMs > 0
      ? eligible.filter((e) => isTimestampOnFilm(e.videoTimestampMs ?? 0, game)).length
      : null;
  return { eligibleMoments: eligible.length, onFilmMoments };
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
  half2StartMs?: number,
  halftimeGapMs?: number,
): Segment[] {
  const segments: Segment[] = [];
  for (const e of eligible) {
    const ts = e.videoTimestampMs;
    // For two-half recordings, the stitched video has the halftime gap removed
    // by the repair step.  Event timestamps for the second half still contain
    // the original game-clock values (including the gap), so we subtract the
    // gap here to convert them to video-file positions.
    const gapAdj =
      half2StartMs != null && halftimeGapMs != null && ts >= half2StartMs
        ? halftimeGapMs
        : 0;
    const adjustedMs = ts - offsetMs - gapAdj;
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
      const mergedLen = Math.max(last.end, end) - last.start;
      if (mergedLen <= MAX_SEGMENT_SEC) {
        last.end = Math.max(last.end, end);
        last.moments.push(moment);
      } else if (end - last.end >= 0.5) {
        // Merging would exceed the cap — start a new segment contiguously at
        // the previous segment's end so no footage is duplicated or lost.
        segments.push({ start: last.end, end, moments: [moment] });
      } else {
        // Degenerate: the new moment barely extends past the capped segment
        // (e.g. clamped at video end) — attach the caption without extending.
        last.moments.push(moment);
      }
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
  srcPath: string | null,
  tmpDir: string,
  prefix: string,
  eligible: { videoTimestampMs: number; playerId: number; statField: string }[],
  nameById: Map<number, string>,
  offsetMs: number = 0,
  half2StartMs?: number,
  halftimeGapMs?: number,
  knownDurationMs?: number,
  // Chunk-based extraction: instead of one full local proxy/source file,
  // segments are rendered directly from individual GCS proxy chunks that are
  // downloaded on demand and deleted as soon as the walk moves past them.
  // Peak tmpfs usage stays at ~2 chunks (~550 MB) no matter how long the
  // game is — the full-proxy concat needed ~2.8 GB and was OOM-killed.
  chunkedSrc?: { chunkObjectPaths: string[]; signal?: AbortSignal },
): Promise<{ segPaths: string[]; hasAudio: boolean }> {
  const chunked = chunkedSrc != null && chunkedSrc.chunkObjectPaths.length > 0;
  if (!chunked && srcPath == null) {
    throw new HighlightError("No video source available for rendering");
  }
  if (chunked && (knownDurationMs == null || knownDurationMs <= 0)) {
    throw new HighlightError("Chunk-based extraction requires a known video duration");
  }

  // --- Chunk manager (chunked mode only) -----------------------------------
  // Chunks are acquired from the module-level shared cache so concurrent
  // highlight and lowlight jobs download each proxy chunk only once.
  const chunkObjectPaths = chunkedSrc?.chunkObjectPaths ?? [];
  const chunkDurs = new Map<number, number>();
  const numProxyChunks = chunkObjectPaths.length;
  // Track which indices THIS job has acquired refs for (for cleanup in finally).
  const acquiredChunks = new Set<number>();
  const ensureChunk = async (i: number): Promise<string> => {
    if (chunkedSrc!.signal?.aborted) throw new HighlightError("Generation cancelled");
    const localPath = await _acquireSharedChunk(chunkObjectPaths[i]);
    acquiredChunks.add(i);
    return localPath;
  };
  const chunkDuration = async (i: number): Promise<number> => {
    let d = chunkDurs.get(i);
    if (d == null) {
      const local = await ensureChunk(i);
      const s = await ffprobe([
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=nw=1:nk=1",
        local,
      ]);
      d = parseFloat(s);
      if (!Number.isFinite(d) || d <= 0) {
        throw new HighlightError(`Could not read proxy chunk ${i} duration`);
      }
      chunkDurs.set(i, d);
    }
    return d;
  };
  const dropChunk = async (i: number): Promise<void> => {
    if (acquiredChunks.has(i)) {
      acquiredChunks.delete(i);
      await _releaseSharedChunk(chunkObjectPaths[i]);
    }
  };
  // --------------------------------------------------------------------------

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
  let activeSrcPath = srcPath ?? "";
  // Chunked mode: proxy chunks are always 720p landscape H264+AAC — per-file
  // probes are skipped with hardcoded settings below.  activeSrcPath is only
  // used by the non-chunked code paths and the gated probe calls further down.
  const isUrl =
    !chunked &&
    srcPath != null &&
    (srcPath.startsWith("http://") || srcPath.startsWith("https://"));

  let duration = NaN;
  if (knownDurationMs != null && knownDurationMs > 0) {
    // Authoritative duration probed from the stored file (WebM tail cluster
    // scan / MP4 header) at upload time. More reliable than any ffprobe
    // cascade — live-recorded WebM has no duration header at all.
    duration = knownDurationMs / 1000;
    logger.info({ prefix, duration, source: "stored-probe" },
      "Using stored video duration");
  } else if (isUrl) {
    // Remote sources (GCS signed URLs) are typically live-recorded WebM or
    // fMP4 with NO duration header and NO seek index — every duration probe
    // returns N/A, and bitrate estimates are wildly wrong for VBR content.
    // Duration is only used to clamp segment windows, so derive a
    // pseudo-duration from the last tagged moment instead. Segments that
    // extend past the true end-of-file simply come out shorter (or empty)
    // in the stream-copy extraction pass below and are dropped there.
    const maxEventSec = eligible.length > 0
      ? Math.max(...eligible.map((e) => (e.videoTimestampMs - offsetMs) / 1000))
      : 0;
    duration = Math.max(1, maxEventSec + POST_SECONDS + 60);
    logger.info({ prefix, duration, source: "event-derived" },
      "Using event-derived pseudo-duration for remote source");
  } else {
    const durationStr = await ffprobe([
      "-v", "error",
      "-analyzeduration", "10000000",
      "-probesize", "10000000",
      "-show_entries", "format=duration",
      "-of", "default=nw=1:nk=1",
      activeSrcPath,
    ]);
    duration = parseFloat(durationStr);
  }

  if (!Number.isFinite(duration) || duration <= 0) {
    const streamDurStr = await ffprobe([
      "-v", "error",
      "-analyzeduration", "150000000",
      "-probesize", "150000000",
      "-select_streams", "v:0",
      "-show_entries", "stream=duration",
      "-of", "default=nw=1:nk=1",
      activeSrcPath,
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
      activeSrcPath,
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
      activeSrcPath,
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
      activeSrcPath,
    ]).catch(() => "");
    const packets = packetRaw.trim().split("\n")
      .map((l) => { const [t, s] = l.split(","); return { t: parseFloat(t), s: Number(s) }; })
      .filter((p) => Number.isFinite(p.t) && p.t >= 0 && p.s > 0);
    if (packets.length > 5) {
      const lastPts = packets[packets.length - 1].t;
      const totalBytes = packets.reduce((acc, p) => acc + p.s, 0);
      if (lastPts > 0 && totalBytes > 0) {
        const empiricalBps = totalBytes / lastPts; // bytes per second
        const srcStatSize = await fs.stat(activeSrcPath).then((s) => s.size).catch(() => 0);
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
    // Not applicable for remote URLs — bail out early with a clear error.
    if (isUrl) {
      throw new HighlightError(
        "Could not determine the video duration from the source stream. " +
        "The recording may be in an unsupported format.",
      );
    }
    const srcStatSize = await fs.stat(activeSrcPath).then((s) => s.size).catch(() => 0);
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
      "-i", activeSrcPath,
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

  // Proxy chunks are always 720p landscape H264+AAC (the proxy encode pass
  // normalises dimensions and strips rotation tags), so all three probes are
  // skipped for chunked mode and the known settings are hardcoded.
  let rawWidth  = 1280;
  let rawHeight = 720;
  if (!chunked) {
    const dims = await ffprobe([
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-of", "csv=s=x:p=0",
      activeSrcPath,
    ]);
    rawWidth  = parseInt(dims.split("x")[0] ?? "1280", 10) || 1280;
    rawHeight = parseInt(dims.split("x")[1] ?? "720",  10) || 720;
  }

  // Some iOS versions incorrectly stamp a `rotate` tag onto canvas-recorded
  // streams.  ffmpeg re-encodes with the raw pixels and ignores the tag by
  // default, so we detect it here and apply a transpose filter to physically
  // rotate the pixels before encoding — giving the highlight reel the correct
  // orientation instead of sideways/stretched output.
  // Proxy chunks: no rotation tag (proxy pass already normalised orientation).
  let displayWidth  = rawWidth;
  let displayHeight = rawHeight;
  let transposeFilter: string | null = null;
  if (!chunked) {
    const rotateMeta = await ffprobe([
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream_tags=rotate",
      "-of", "default=nw=1:nk=1",
      activeSrcPath,
    ]).catch(() => "0");
    const rotationDeg = parseInt(rotateMeta.trim() || "0", 10) || 0;
    if (rotationDeg === 90) {
      transposeFilter = "transpose=1";           // 90° CW
      [displayWidth, displayHeight] = [rawHeight, rawWidth];
    } else if (rotationDeg === 270 || rotationDeg === -90) {
      transposeFilter = "transpose=2";           // 90° CCW
      [displayWidth, displayHeight] = [rawHeight, rawWidth];
    } else if (rotationDeg === 180) {
      transposeFilter = "transpose=1,transpose=1"; // 180°
    }
  }

  const height = displayHeight;

  // Proxy chunks always include an AAC audio stream (the proxy pass adds one
  // even for silent sources).  Non-chunked sources probe the actual file.
  let hasAudio: boolean;
  if (chunked) {
    hasAudio = true;
  } else {
    const audioStreams = await ffprobe([
      "-v", "error",
      "-select_streams", "a",
      "-show_entries", "stream=index",
      "-of", "csv=p=0",
      activeSrcPath,
    ]);
    hasAudio = audioStreams.length > 0;
  }

  let segments = buildSegments(eligible, duration, nameById, offsetMs, half2StartMs, halftimeGapMs);
  if (segments.length === 0) return { segPaths: [], hasAudio };

  // Chunked mode: pre-compute which chunk indices contain ≥1 segment using
  // nominal PROXY_CHUNK_DURATION_SEC boundaries.  Chunks outside this set are
  // skipped (never downloaded) during the walk below.  Actual chunk edges may
  // differ from nominal by ≤ the keyframe interval (~1–2 s for the veryfast
  // preset), introducing a small localSeek drift per skipped chunk —
  // negligible for PRE_SECONDS=12 clips.
  const neededChunks = new Set<number>();
  if (chunked) {
    for (const seg of segments) {
      // Include the chunk that holds the lead-in (seg.start may be in the
      // previous chunk when the PRE_SECONDS window crosses a chunk boundary).
      const ciStart = Math.max(0, Math.floor(seg.start / PROXY_CHUNK_DURATION_SEC));
      // +1 margin so a segment whose end lands near a boundary also covers
      // the next chunk (boundary-spanning case handled by concat-demuxer).
      const ciEnd = Math.min(
        numProxyChunks - 1,
        Math.floor((seg.end + 1) / PROXY_CHUNK_DURATION_SEC),
      );
      for (let ci = ciStart; ci <= ciEnd; ci++) neededChunks.add(ci);
    }
    logger.info(
      { prefix, neededChunks: [...neededChunks].sort((a, b) => a - b), total: numProxyChunks },
      "Chunk walk: skipping empty chunks",
    );
  }

  // ---------------------------------------------------------------------------
  // Parallel chunk pre-download (chunked mode only).
  //
  // Downloading proxy chunks one-at-a-time in the linear render walk is the
  // dominant bottleneck for existing proxies: each 250 MB chunk takes 30-60 s
  // from GCS, so 3 needed chunks = 90-180 s sequentially vs. ~30-60 s when
  // all three download concurrently.  We pre-download all needed chunks in
  // parallel here, before the render walk starts, so every ensureChunk() call
  // inside the walk returns immediately from the shared-chunk cache.
  //
  // Memory bound: limit parallel preload to 4 chunks (≈ 1 GB peak tmpfs on
  // the RAM-backed /tmp).  Games with > 4 needed chunks fall back to the
  // sequential walk which keeps ≤ 2 chunks resident at a time.
  //
  // Ref-counting: each _acquireSharedChunk call increments the shared ref.
  // We track these preload refs separately (preloadedRefs) so the finally
  // block can release them alongside the per-render refs already in
  // acquiredChunks.  A chunk acquired for both preload and render has refs=2
  // and is deleted only after both are released — no early eviction.
  // ---------------------------------------------------------------------------
  const MAX_PARALLEL_PRELOAD = 6;
  const preloadedRefs: number[] = []; // chunk indices with an extra preload ref
  if (chunked && neededChunks.size > 0 && neededChunks.size <= MAX_PARALLEL_PRELOAD) {
    const sorted = [...neededChunks].sort((a, b) => a - b);
    logger.info(
      { prefix, chunks: sorted },
      "Chunk walk: pre-downloading needed chunks in parallel",
    );
    try {
      await Promise.all(
        sorted.map(async (ci) => {
          if (chunkedSrc!.signal?.aborted) throw new HighlightError("Generation cancelled");
          await _acquireSharedChunk(chunkObjectPaths[ci]);
          preloadedRefs.push(ci);
        }),
      );
      logger.info({ prefix }, "Chunk walk: parallel pre-download complete");
    } catch (preloadErr) {
      // One or more downloads failed or was cancelled.  Release every ref that
      // WAS successfully acquired before the failure so no tmpfs files leak.
      // preloadedRefs is populated atomically (push after await), so it contains
      // exactly the chunks that completed before the first rejection.
      // The chunked-walk finally block sees an empty preloadedRefs and skips
      // the double-release pass — clearing the array prevents that.
      for (const ci of preloadedRefs) {
        await _releaseSharedChunk(chunkObjectPaths[ci]);
      }
      preloadedRefs.length = 0;
      throw preloadErr;
    }
  }

  // Phase A (remote sources only): single-pass stream-copy extraction.
  // A cueless live-recorded WebM cannot be seeked over HTTP — every -ss
  // triggers a linear scan from byte 0, so per-clip remote seeking would be
  // O(clips × filesize). Instead, ONE ffmpeg invocation reads the source
  // linearly at network speed (no decode) and stream-copies every clip
  // window into a small local file. MediaRecorder keyframes are ~2s apart,
  // so a fixed pre-pad guarantees a keyframe lands before the clip start;
  // the precise cut happens in the local re-encode below (renderOne).
  let segInputs: { path: string; seek: number; concatInput?: boolean }[] | null = null;
  if (isUrl) {
    const COPY_PAD_SECONDS = 6;
    const copyArgs: string[] = [
      "-y", "-v", "error",
      "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "10",
      "-i", activeSrcPath,
    ];
    const wins = segments.map((seg, i) => {
      const winStart = Math.max(0, seg.start - COPY_PAD_SECONDS);
      const winPath = path.join(tmpDir, `win_${prefix}_${i}.mkv`);
      copyArgs.push(
        "-map", "0",
        "-c", "copy",
        "-ss", winStart.toFixed(3),
        "-to", (seg.end + 0.5).toFixed(3),
        "-avoid_negative_ts", "make_zero",
        winPath,
      );
      return { path: winPath, seek: seg.start - winStart };
    });
    logger.info({ prefix, windows: wins.length },
      "Starting single-pass stream-copy extraction from remote source");
    const copyStart = Date.now();
    await runFfmpegQueued(copyArgs, 30 * 60 * 1000);
    logger.info({ prefix, ms: Date.now() - copyStart },
      "Stream-copy extraction complete");

    // Drop segments whose window landed past the true end of the recording —
    // the pseudo-duration is event-derived and may exceed the actual video.
    const keptSegments: Segment[] = [];
    const keptInputs: { path: string; seek: number; concatInput?: boolean }[] = [];
    for (let i = 0; i < segments.length; i++) {
      const size = await fs.stat(wins[i].path).then((s) => s.size).catch(() => 0);
      if (size > 20_000) {
        keptSegments.push(segments[i]);
        keptInputs.push(wins[i]);
      } else {
        logger.warn({ prefix, i, size },
          "Dropping segment window past end of source video");
      }
    }
    segments = keptSegments;
    segInputs = keptInputs;
    if (segments.length === 0) return { segPaths: [], hasAudio };
  }

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

  const renderOne = async (
    seg: Segment,
    i: number,
    // Chunked mode passes the local chunk file (or a concat list spanning two
    // chunks) with a seek RELATIVE to that input's own timeline.
    inputOverride?: { path: string; seek: number; concatInput?: boolean },
  ): Promise<string> => {
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
    // Same orientation-aware logic as the proxy encoder: portrait proxy chunks
    // (iw < ih) target 720×1280, landscape chunks target 1280×720.
    filterParts.push(
      `scale='if(gte(iw,ih),${OUTPUT_WIDTH},${OUTPUT_HEIGHT})':'if(gte(iw,ih),${OUTPUT_HEIGHT},${OUTPUT_WIDTH})':force_original_aspect_ratio=decrease:flags=fast_bilinear,` +
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
    // Build filter_complex.
    // Music is intentionally NOT mixed into individual segments.  Doing so
    // causes the music track to reset to the beginning for every clip after
    // concatenation, producing an audible pop/restart at every clip boundary.
    // Instead, segments carry only the source audio (or are audio-free when
    // the source has no audio), and music is mixed in a single combined
    // concat+music pass inside concatSegments() after all segments are ready.
    const fcParts = [
      `[0:v]${mainFilters}[main]`,
      `[1:v]scale=-1:${wmLogoHeight},format=rgba,colorchannelmixer=aa=0.65[logo]`,
      `[main][logo]overlay=W-w-${wmLogoMargin}:${wmLogoMargin}:shortest=1[out]`,
    ];
    const filterComplex = fcParts.join(";");

    const segPath = path.join(tmpDir, `seg_${prefix}_${i}.ts`);
    // When Phase A ran, encode from the small local intermediate (seek is
    // relative to the window start); otherwise seek directly in the source.
    const input =
      inputOverride ?? (segInputs ? segInputs[i] : { path: activeSrcPath, seek: seg.start });
    const args = [
      "-y",
      // Concat demuxer must be declared before -i; -ss then seeks across the
      // virtual concatenated timeline (chunks have reset timestamps).
      ...(input.concatInput ? ["-f", "concat", "-safe", "0"] : []),
      "-ss", input.seek.toFixed(3),
      "-i", input.path,
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

  const segPaths: string[] = [];

  if (chunked) {
    // Single-pass walk over the proxy chunks. Segments come out of
    // buildSegments sorted by start time, so one linear pass suffices: each
    // chunk is downloaded on demand and deleted as soon as the walk moves
    // past it — at most 2 chunks (~550 MB) are ever resident in tmpfs.
    //
    // A segment is capped at MAX_SEGMENT_SEC (300 s) < chunk duration
    // (360 s), so it spans AT MOST two adjacent chunks; boundary-spanning
    // segments are rendered from a 2-entry concat-demuxer list.
    try {
      // Walk proxy chunks sequentially.  Chunks absent from neededChunks are
      // skipped without downloading — chunkStart advances by the nominal
      // PROXY_CHUNK_DURATION_SEC so we avoid a costly ffprobe just to measure
      // an empty chunk.  For the last NEEDED chunk, duration is derived from
      // the stored knownDurationMs to skip that ffprobe too.
      let chunkStart = 0; // absolute start time of chunk ci in the proxy timeline
      let segIdx = 0;
      for (let ci = 0; ci < numProxyChunks && segIdx < segments.length; ci++) {
        const isLastChunk = ci === numProxyChunks - 1;

        if (!neededChunks.has(ci)) {
          // No moments in this chunk — skip the download and advance using the
          // nominal chunk duration.  Drift vs. actual edges: ≤ keyframe interval
          // (~1–2 s) per skipped chunk, which is acceptable for PRE=12 s clips.
          chunkStart += PROXY_CHUNK_DURATION_SEC;
          continue;
        }

        // Use nominal chunk duration for all non-last chunks — this avoids
        // a `chunkDuration(ci)` call which would download the chunk AND run
        // an ffprobe just to get the duration.  Proxy chunks are encoded at
        // PROXY_CHUNK_DURATION_SEC intervals; actual edges may differ by
        // ≤ keyframe interval (~1–2 s), introducing a small localSeek drift
        // that is negligible for PRE_SECONDS=12 clips.
        // For the last chunk, derive from stored total (exact — no probe).
        const chunkDur = isLastChunk
          ? Math.max(0, knownDurationMs! / 1000 - chunkStart)
          : PROXY_CHUNK_DURATION_SEC;
        const chunkEnd = chunkStart + chunkDur;

        while (segIdx < segments.length && segments[segIdx].start < chunkEnd) {
          const seg = segments[segIdx];
          // seg.start may fall in the previous chunk when the PRE_SECONDS
          // lead-in window crosses a chunk boundary (e.g. the moment is near
          // the start of this chunk).  In that case localSeek would clamp to 0
          // and the clip would be missing its lead-in footage.  Detect this and
          // use the concat-demuxer path with the previous chunk prepended so the
          // full lead-in is present.
          const leadInInPrevChunk = seg.start < chunkStart && ci > 0;
          const localSeek = leadInInPrevChunk
            ? seg.start - (chunkStart - PROXY_CHUNK_DURATION_SEC) // seek into prev chunk
            : Math.max(0, seg.start - chunkStart);

          const spansNextChunk = seg.end > chunkEnd + 0.001 && !isLastChunk;

          // Diagnostic: log exact timing so we can verify lead-in footage is
          // correctly included for every segment (visible in prod logs).
          logger.info(
            {
              prefix, segIdx, ci,
              chunkStart: chunkStart.toFixed(1),
              segStart: seg.start.toFixed(3),
              segEnd: seg.end.toFixed(3),
              localSeek: localSeek.toFixed(3),
              leadInInPrevChunk,
              spansNextChunk,
              momentsSec: seg.moments.map((m) => m.timeSec.toFixed(3)),
            },
            "Chunk walk: rendering segment",
          );

          if (leadInInPrevChunk && !spansNextChunk) {
            // Lead-in is in chunk ci-1, body/end is fully in chunk ci.
            const prevLocal = await ensureChunk(ci - 1);
            const thisLocal = await ensureChunk(ci);
            const listPath = path.join(tmpDir, `xchunk_${prefix}_${segIdx}.txt`);
            await fs.writeFile(
              listPath, `file '${prevLocal}'\nfile '${thisLocal}'\n`, "utf8",
            );
            try {
              segPaths.push(
                await renderOne(seg, segIdx, { path: listPath, seek: localSeek, concatInput: true }),
              );
            } finally {
              await fs.unlink(listPath).catch(() => {});
            }
          } else if (leadInInPrevChunk && spansNextChunk) {
            // Rare: lead-in in ci-1, end in ci+1 — three-chunk span.
            // Use prev+this for seek; ffmpeg will stop reading at seg.end which
            // may be slightly past the concat boundary but the next chunk is not
            // needed for the seek anchor, so treat it as clamped at chunkEnd.
            const prevLocal = await ensureChunk(ci - 1);
            const thisLocal = await ensureChunk(ci);
            const listPath = path.join(tmpDir, `xchunk_${prefix}_${segIdx}.txt`);
            await fs.writeFile(
              listPath, `file '${prevLocal}'\nfile '${thisLocal}'\n`, "utf8",
            );
            try {
              segPaths.push(
                await renderOne(seg, segIdx, { path: listPath, seek: localSeek, concatInput: true }),
              );
            } finally {
              await fs.unlink(listPath).catch(() => {});
            }
          } else if (spansNextChunk) {
            // No lead-in issue, but end spans into chunk ci+1.
            const thisLocal = await ensureChunk(ci);
            const nextLocal = await ensureChunk(ci + 1);
            const listPath = path.join(tmpDir, `xchunk_${prefix}_${segIdx}.txt`);
            await fs.writeFile(
              listPath, `file '${thisLocal}'\nfile '${nextLocal}'\n`, "utf8",
            );
            try {
              segPaths.push(
                await renderOne(seg, segIdx, { path: listPath, seek: localSeek, concatInput: true }),
              );
            } finally {
              await fs.unlink(listPath).catch(() => {});
            }
          } else {
            // Fully inside this chunk (or clamped by end of footage — ffmpeg
            // simply stops at EOF and the clip comes out shorter).
            segPaths.push(
              await renderOne(seg, segIdx, { path: await ensureChunk(ci), seek: localSeek }),
            );
          }
          segIdx++;
        }

        // Drop chunk ci-1 now that the walk has moved past ci — it can no
        // longer be needed as a lead-in chunk (lead-in for segments in ci+1
        // might still need ci, so we drop ci-1 rather than ci here).
        // Chunk ci itself will be dropped on the next iteration when ci+1
        // becomes the current chunk, or in the finally block at the end.
        if (ci > 0) await dropChunk(ci - 1);
        chunkStart = chunkEnd;
      }

      // Any segments left over start past the end of the last chunk — the
      // stored duration overshot the real footage. Warn and drop, same as
      // the remote-source path does for windows past EOF.
      if (segIdx < segments.length) {
        logger.warn(
          { prefix, dropped: segments.length - segIdx },
          "Dropping segments past end of proxy chunks (stored duration overshot footage)",
        );
      }
    } finally {
      // Release preload refs first (extra refs from parallel pre-download above).
      // A chunk that was both preloaded and rendered has refs = 2; releasing both
      // sets refs = 0 so the tmpfs file is actually deleted.
      for (const ci of preloadedRefs) {
        await _releaseSharedChunk(chunkObjectPaths[ci]);
      }
      for (const ci of [...acquiredChunks]) {
        await dropChunk(ci);
      }
    }
    return { segPaths, hasAudio };
  }

  // Process in ordered batches — results within each batch are parallel but
  // the overall array order matches segment order for the concat step.
  for (let b = 0; b < segments.length; b += RENDER_CONCURRENCY) {
    const batch = segments.slice(b, b + RENDER_CONCURRENCY);
    const results = await Promise.all(batch.map((seg, j) => renderOne(seg, b + j)));
    segPaths.push(...results);
  }

  return { segPaths, hasAudio };
}

export async function concatSegments(
  segPaths: string[],
  tmpDir: string,
  outPath: string,
  hasAudio: boolean,
  musicTrackPath?: string,
): Promise<void> {
  const listPath = path.join(tmpDir, `list_${path.basename(outPath)}.txt`);
  await fs.writeFile(
    listPath,
    segPaths.map((p) => `file '${p}'`).join("\n"),
    "utf8",
  );

  if (musicTrackPath) {
    // Single-pass: concat segments and mix music in one ffmpeg invocation.
    // This eliminates the intermediate highlight_concat.mp4 file and saves
    // one trip through the global ffmpeg queue serialiser compared to the
    // old two-pass approach (concatSegments → mixMusicIntoReel).
    //
    // Input 0: MPEG-TS segments via concat demuxer.
    // Input 1: music track looped for the full reel duration.
    // Video is stream-copied; audio is decoded, mixed, and re-encoded to AAC
    // (so aac_adtstoasc is not needed — we're not copying TS audio packets).
    const concatArgs = [
      "-y",
      "-f", "concat", "-safe", "0", "-i", listPath,
      "-stream_loop", "-1", "-i", musicTrackPath,
    ];

    if (hasAudio) {
      // Blend original game audio (weight 1) with background music (weight 0.2).
      // duration=first trims the music to the video length.
      concatArgs.push(
        "-filter_complex", "[0:a][1:a]amix=inputs=2:duration=first:weights=1 0.2[aout]",
        "-map", "0:v",
        "-map", "[aout]",
      );
    } else {
      // No source audio — music only, trimmed to video length.
      concatArgs.push(
        "-filter_complex", "[1:a]volume=0.3[aout]",
        "-map", "0:v",
        "-map", "[aout]",
      );
    }

    concatArgs.push(
      "-c:v", "copy",
      "-c:a", "aac", "-ar", "44100", "-b:a", "128k", "-ac", "2",
      "-shortest",
      "-movflags", "+faststart",
      outPath,
    );

    await runFfmpegQueued(concatArgs);
    return;
  }

  // No music: plain stream-copy concat.
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

/**
 * Mix a music track into a fully-concatenated reel MP4, producing a new file
 * at outPath.  This is the correct place to apply music so that the track
 * plays continuously from beginning to end — mixing per-segment would restart
 * the track at every clip boundary and produce an audible pop.
 *
 * - When the source reel has audio: blend at 20% music / 100% original audio.
 * - When the source reel has no audio: music only at 30% volume.
 * Music is always truncated to the video duration (-shortest).
 */
export async function mixMusicIntoReel(
  concatPath: string,
  outPath: string,
  musicTrackPath: string,
  reelHasAudio: boolean,
): Promise<void> {
  // Guard: verify the music track file exists before handing it to ffmpeg.
  // A missing track causes an opaque ffmpeg error; catch it early with a clear message.
  try {
    await fs.access(musicTrackPath);
  } catch {
    throw new HighlightError(
      `Music track file could not be opened: "${musicTrackPath}". ` +
      `Check that the track asset exists at the expected path.`,
    );
  }

  const args = [
    "-y",
    "-i", concatPath,
    "-stream_loop", "-1", "-i", musicTrackPath,
  ];

  if (reelHasAudio) {
    // Blend original game audio (weight 1) with background music (weight 0.2).
    // duration=first trims the music to the video length; -shortest below is
    // an additional safety net so ffmpeg doesn't wait on the looped music input.
    args.push(
      "-filter_complex", "[0:a][1:a]amix=inputs=2:duration=first:weights=1 0.2[aout]",
      "-map", "0:v",
      "-map", "[aout]",
    );
  } else {
    // No source audio — music only, trimmed to video length.
    args.push(
      "-filter_complex", "[1:a]volume=0.3[aout]",
      "-map", "0:v",
      "-map", "[aout]",
    );
  }

  args.push(
    "-c:v", "copy",
    "-c:a", "aac", "-ar", "44100", "-b:a", "128k", "-ac", "2",
    "-shortest",
    "-movflags", "+faststart",
    outPath,
  );

  await runFfmpegQueued(args);
}

async function uploadHighlight(outPath: string, ownerId: number): Promise<string> {
  // Use GCS SDK streaming upload (pipeline → createWriteStream) instead of
  // reading the whole file into a Buffer and POSTing to a signed URL.
  // The signed-URL path dropped the connection ("other side closed") on large
  // lowlight files because undici buffered the entire body before sending and
  // GCS closed the idle socket.  The SDK path streams the file directly.
  const objectId = randomUUID();
  const objectPath = `/objects/uploads/${ownerId}/${objectId}`;
  const MAX_ATTEMPTS = 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await objectStorageService.uploadLocalFileToObjectPath(outPath, objectPath, "video/mp4");
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
export async function generateHighlight(gameId: number, musicTrackPath?: string): Promise<void> {
  const ac = new AbortController();
  highlightAbortControllers.set(gameId, ac);
  let tmpDir: string | null = null;
  let releaseReelSlot: (() => void) | null = null;
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

    // Acquire the global reel slot so that highlight + lowlight jobs never
    // download chunks concurrently.  Peak /tmp stays ≤2 chunks (~550 MB).
    {
      const [slotReady, slotRelease] = _acquireReelSlot();
      releaseReelSlot = slotRelease;
      logger.info({ gameId }, "Highlight: waiting for reel slot");
      await slotReady;
    }
    if (ac.signal.aborted) throw new HighlightError("Cancelled");

    // Cut clips directly from individual proxy chunks in GCS — downloaded on
    // demand and deleted as the render walk moves past them, so peak tmpfs
    // usage stays ~2 chunks (~550 MB). The full concatenated proxy is NEVER
    // built locally: /tmp is RAM-backed in production, and the old
    // download-all-chunks-and-concat path (~2.8 GB peak on a 34-min game)
    // was OOM-killed every time. Falls back to the raw source only if the
    // chunk path fails (e.g. video duration unknown).
    logger.info({ gameId }, "Highlight: preparing proxy chunks");
    let rendered: { segPaths: string[]; hasAudio: boolean };

    // Compute the last proxy chunk that actually contains a highlight moment.
    // Passing this to ensureProxyChunksInGcs lets the encoder stop after that
    // chunk instead of transcoding the entire game — a major win when all
    // moments cluster in the first half (saves encoding the tail chunks).
    const highlightMaxChunkNeeded = (() => {
      const durSec = (game.videoDurationMs ?? 0) / 1000;
      const totalChunks = Math.max(1, Math.ceil(durSec / PROXY_CHUNK_DURATION_SEC));
      const adjustedEndTimes = eligible.map((e) => {
        const ts = e.videoTimestampMs ?? 0;
        const gapAdj =
          game.videoHalf2StartMs != null &&
          game.videoHalftimeGapMs != null &&
          ts >= game.videoHalf2StartMs
            ? game.videoHalftimeGapMs
            : 0;
        return (ts - (game.videoOffsetMs ?? 0) - gapAdj) / 1000;
      }).filter((t) => t >= 0);
      if (adjustedEndTimes.length === 0) return undefined;
      const maxTimeSec = Math.max(...adjustedEndTimes) + POST_SECONDS;
      return Math.min(Math.floor(maxTimeSec / PROXY_CHUNK_DURATION_SEC), totalChunks - 1);
    })();
    logger.info({ gameId, highlightMaxChunkNeeded }, "Highlight: computed max needed chunk index");

    // Track whether ensureProxyChunksInGcs confirmed chunks are in GCS.
    // If true, the raw-source fallback MUST NOT fire — downloading a 1+ GB raw
    // source while another job does the same would exceed the 2 GB RAM-backed
    // /tmp limit and OOM-kill the server. Fail cleanly instead so the user can
    // retry; on retry the chunks are already in GCS and only the extraction
    // (not the source download) needs to succeed.
    let highlightChunksConfirmed = false;
    try {
      const chunkObjectPaths = await ensureProxyChunksInGcs(
        gameId, game.ownerId, game, ac.signal, highlightMaxChunkNeeded,
      );
      highlightChunksConfirmed = true;
      rendered = await renderGameSegments(
        null, tmpDir, "g", eligible, nameById,
        game.videoOffsetMs ?? 0,
        game.videoHalf2StartMs ?? undefined,
        game.videoHalftimeGapMs ?? undefined,
        game.videoDurationMs ?? undefined,
        { chunkObjectPaths, signal: ac.signal },
      );
    } catch (chunkErr) {
      if (ac.signal.aborted) throw chunkErr;
      if (highlightChunksConfirmed) {
        // Chunks are confirmed in GCS — raw-source fallback would OOM the server.
        // Surface a retryable error; chunks stay in GCS for the next attempt.
        logger.error({ err: chunkErr, gameId },
          "Highlight: chunk extraction failed with chunks confirmed — refusing raw-source fallback to prevent OOM");
        throw new HighlightError(
          "Highlight generation timed out. Please try again.",
        );
      }
      logger.warn({ err: chunkErr, gameId },
        "Highlight: chunk-based extraction unavailable — falling back to raw source video");
      const { srcPath, release } = await acquireSourceVideo(game.videoObjectPath!, ac.signal);
      try {
        rendered = await renderGameSegments(
          srcPath, tmpDir, "g", eligible, nameById,
          game.videoOffsetMs ?? 0,
          game.videoHalf2StartMs ?? undefined,
          game.videoHalftimeGapMs ?? undefined,
          game.videoDurationMs ?? undefined,
        );
      } finally {
        release();
      }
    }
    const { segPaths, hasAudio } = rendered;
    if (segPaths.length === 0) {
      throw new HighlightError("No qualifying highlight moments in this game");
    }

    // Music is combined with the concat in a single ffmpeg pass (see
    // concatSegments) so the track plays continuously across all clips without
    // resetting at each boundary, and no intermediate file is written to disk.
    const outPath = path.join(tmpDir, "highlight.mp4");
    await concatSegments(segPaths, tmpDir, outPath, hasAudio, musicTrackPath);

    // Guard: check the game still exists before writing any new GCS object.
    // If the game was deleted while we were generating, discard the output
    // rather than uploading an orphaned reel that can never be cleaned up.
    {
      const stillExists = await db.query.gamesTable.findFirst({
        where: eq(gamesTable.id, gameId),
        columns: { id: true },
      });
      if (!stillExists) {
        logger.warn({ gameId }, "Highlight: game was deleted mid-generation — discarding output");
        return;
      }
    }

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
    highlightAbortControllers.delete(gameId);
    releaseReelSlot?.();
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
export async function generateLowlight(gameId: number, musicTrackPath?: string): Promise<void> {
  const ac = new AbortController();
  lowlightAbortControllers.set(gameId, ac);
  let tmpDir: string | null = null;
  let releaseReelSlot: (() => void) | null = null;
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

    // Acquire the global reel slot — same OOM-prevention as generateHighlight.
    {
      const [slotReady, slotRelease] = _acquireReelSlot();
      releaseReelSlot = slotRelease;
      logger.info({ gameId }, "Lowlight: waiting for reel slot");
      await slotReady;
    }
    if (ac.signal.aborted) throw new HighlightError("Cancelled");

    // Cut clips directly from individual proxy chunks in GCS — same bounded
    // tmpfs reasoning as generateHighlight. Concurrent highlight + lowlight
    // jobs share one chunk-ensure pass via the single-flight guard.
    logger.info({ gameId }, "Lowlight: preparing proxy chunks");
    let rendered: { segPaths: string[]; hasAudio: boolean };

    // Same early-termination optimization as generateHighlight: compute the
    // last proxy chunk that contains a lowlight moment and stop encoding there.
    const lowlightMaxChunkNeeded = (() => {
      const durSec = (game.videoDurationMs ?? 0) / 1000;
      const totalChunks = Math.max(1, Math.ceil(durSec / PROXY_CHUNK_DURATION_SEC));
      const adjustedEndTimes = eligible.map((e) => {
        const ts = e.videoTimestampMs ?? 0;
        const gapAdj =
          game.videoHalf2StartMs != null &&
          game.videoHalftimeGapMs != null &&
          ts >= game.videoHalf2StartMs
            ? game.videoHalftimeGapMs
            : 0;
        return (ts - (game.videoOffsetMs ?? 0) - gapAdj) / 1000;
      }).filter((t) => t >= 0);
      if (adjustedEndTimes.length === 0) return undefined;
      const maxTimeSec = Math.max(...adjustedEndTimes) + POST_SECONDS;
      return Math.min(Math.floor(maxTimeSec / PROXY_CHUNK_DURATION_SEC), totalChunks - 1);
    })();
    logger.info({ gameId, lowlightMaxChunkNeeded }, "Lowlight: computed max needed chunk index");

    let lowlightChunksConfirmed = false;
    try {
      const chunkObjectPaths = await ensureProxyChunksInGcs(
        gameId, game.ownerId, game, ac.signal, lowlightMaxChunkNeeded,
      );
      lowlightChunksConfirmed = true;
      rendered = await renderGameSegments(
        null, tmpDir, "ll", eligible, nameById,
        game.videoOffsetMs ?? 0,
        game.videoHalf2StartMs ?? undefined,
        game.videoHalftimeGapMs ?? undefined,
        game.videoDurationMs ?? undefined,
        { chunkObjectPaths, signal: ac.signal },
      );
    } catch (chunkErr) {
      if (ac.signal.aborted) throw chunkErr;
      if (lowlightChunksConfirmed) {
        // Same OOM-prevention guard as generateHighlight: chunks exist in GCS,
        // refuse raw-source fallback, fail cleanly for user to retry.
        logger.error({ err: chunkErr, gameId },
          "Lowlight: chunk extraction failed with chunks confirmed — refusing raw-source fallback to prevent OOM");
        throw new HighlightError(
          "Lowlight generation timed out. Please try again.",
        );
      }
      logger.warn({ err: chunkErr, gameId },
        "Lowlight: chunk-based extraction unavailable — falling back to raw source video");
      const { srcPath, release } = await acquireSourceVideo(game.videoObjectPath!, ac.signal);
      try {
        rendered = await renderGameSegments(
          srcPath, tmpDir, "ll", eligible, nameById,
          game.videoOffsetMs ?? 0,
          game.videoHalf2StartMs ?? undefined,
          game.videoHalftimeGapMs ?? undefined,
          game.videoDurationMs ?? undefined,
        );
      } finally {
        release();
      }
    }
    const { segPaths, hasAudio } = rendered;
    if (segPaths.length === 0) {
      throw new HighlightError("No lowlight moments could be rendered");
    }

    // Music is combined with the concat in a single ffmpeg pass (see
    // concatSegments) so the track plays continuously across all clips without
    // resetting at each boundary, and no intermediate file is written to disk.
    const outPath = path.join(tmpDir, "lowlight.mp4");
    await concatSegments(segPaths, tmpDir, outPath, hasAudio, musicTrackPath);

    // Guard: check the game still exists before writing any new GCS object.
    // If the game was deleted while we were generating, discard the output
    // rather than uploading an orphaned reel that can never be cleaned up.
    {
      const stillExists = await db.query.gamesTable.findFirst({
        where: eq(gamesTable.id, gameId),
        columns: { id: true },
      });
      if (!stillExists) {
        logger.warn({ gameId }, "Lowlight: game was deleted mid-generation — discarding output");
        return;
      }
    }

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
    lowlightAbortControllers.delete(gameId);
    releaseReelSlot?.();
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

    // Process games SEQUENTIALLY, not in parallel. All ffmpeg work is
    // globally serialized through runFfmpegQueued anyway, so parallelism
    // bought no wall-clock time — it only multiplied peak tmpfs usage
    // (N games × resident chunks/sources at once = OOM on RAM-backed /tmp).
    const gameResults: { segPaths: string[]; hasAudio: boolean }[] = [];
    for (const game of videoGames) {
      const eligible = eventsByGame.get(game.id);
      if (!eligible || eligible.length === 0) {
        gameResults.push({ segPaths: [], hasAudio: false });
        continue;
      }

      // Chunk-based extraction first (bounded tmpfs); fall back to
      // downloading the raw source only if the chunk path fails AND chunks
      // were NOT confirmed in GCS (confirmed chunks + raw fallback = OOM).
      let result: { segPaths: string[]; hasAudio: boolean };
      let teamChunksConfirmed = false;
      try {
        const chunkObjectPaths = await ensureProxyChunksInGcs(game.id, team.ownerId!, game);
        teamChunksConfirmed = true;
        result = await renderGameSegments(
          null, tmpDir!, `t${game.id}`, eligible, nameById,
          game.videoOffsetMs ?? 0,
          game.videoHalf2StartMs ?? undefined,
          game.videoHalftimeGapMs ?? undefined,
          game.videoDurationMs ?? undefined,
          { chunkObjectPaths },
        );
      } catch (chunkErr) {
        if (teamChunksConfirmed) {
          // Chunks exist — refuse raw-source fallback, skip this game cleanly.
          logger.warn({ err: chunkErr, gameId: game.id },
            "Team highlight: chunk extraction timed out with chunks confirmed — skipping game (refusing OOM fallback)");
          gameResults.push({ segPaths: [], hasAudio: false });
          continue;
        }
        logger.warn({ err: chunkErr, gameId: game.id },
          "Team highlight: chunk-based extraction unavailable — downloading raw source video");
        const srcPath = path.join(tmpDir!, `src_${game.id}`);
        await downloadSourceVideo(game.videoObjectPath!, srcPath);
        try {
          result = await renderGameSegments(
            srcPath, tmpDir!, `t${game.id}`, eligible, nameById,
            game.videoOffsetMs ?? 0,
            game.videoHalf2StartMs ?? undefined,
            game.videoHalftimeGapMs ?? undefined,
            game.videoDurationMs ?? undefined,
          );
        } finally {
          // Free the raw source before moving to the next game — keeping N
          // full sources resident is exactly the OOM pattern being removed.
          await fs.unlink(srcPath).catch(() => {});
        }
      }
      gameResults.push(result);
    }

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

/**
 * Trigger a background encode of ALL proxy chunks for a long game and upload
 * them to GCS one at a time (deleteAfterUpload=true keeps peak /tmp usage at
 * source + ≤1 chunk). Unlike ensureGameProxyInBackground this never tries to
 * download and concat all chunks locally, so it is safe for games of any
 * length on RAM-backed /tmp.
 *
 * No-ops if a build (proxy or HLS) is already in progress for this game, or
 * if all estimated chunks are already in GCS.
 */
export function ensureAllProxyChunksInBackground(
  gameId: number,
  ownerId: number,
  videoObjectPath: string,
  durationMs: number,
): void {
  if (backgroundProxyBuilds.has(gameId) || backgroundHlsBuilds.has(gameId)) return;
  backgroundHlsBuilds.add(gameId);
  (async () => {
    // Fast-path: sentinel already present means a prior run completed the build.
    // getReadyProxyChunkCount reads the sentinel, not a duration estimate.
    const existingCount = await getReadyProxyChunkCount(gameId, ownerId, durationMs);
    if (existingCount > 0) {
      logger.info({ gameId, existingCount }, "HLS chunk build: sentinel present — skipping");
      return;
    }

    const durationSec = durationMs / 1000;
    const numChunksGuess = Math.max(1, Math.ceil(durationSec / PROXY_CHUNK_DURATION_SEC));
    const existFlags = await Promise.all(
      Array.from({ length: numChunksGuess }, (_, i) =>
        proxyChunkExistsInGcs(makeProxyChunkGcsPath(ownerId, gameId, i)),
      ),
    );

    if (existFlags.every(Boolean)) {
      // All estimated chunks are already in GCS (built by a prior run or the
      // highlight/lowlight pipeline).  Probe past the estimate for the true
      // count, then write the sentinel so future polls resolve immediately.
      let trueCount = numChunksGuess;
      while (
        trueCount < numChunksGuess + 50 &&
        await proxyChunkExistsInGcs(makeProxyChunkGcsPath(ownerId, gameId, trueCount))
      ) {
        trueCount++;
      }
      logger.info({ gameId, trueCount }, "HLS chunk build: all estimated chunks in GCS — writing sentinel");
      // We don't have local files to ffprobe for these pre-existing GCS chunks,
      // so use PROXY_CHUNK_DURATION_SEC as an approximation.  The sentinel is
      // still authoritative for chunk COUNT; per-chunk EXTINF accuracy is
      // bounded by one GOP (≤2 s) which AVPlayer tolerates well.
      await writeHlsSentinel(
        ownerId, gameId, trueCount,
        Array<number>(trueCount).fill(PROXY_CHUNK_DURATION_SEC),
      );
      return;
    }

    const firstMissing = existFlags.findIndex((e) => !e);
    const workDir = path.join(
      os.tmpdir(),
      `video-proxy-enc-${gameId}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.mkdir(workDir, { recursive: true });
    logger.info({ gameId, firstMissing, numChunksGuess }, "HLS chunk build: starting background encode");
    const { srcPath, release } = await acquireSourceVideo(videoObjectPath);
    try {
      // encodeChunksToGcs returns the ACTUAL number of chunks and ffprobe-
      // measured per-segment durations — both stored in the sentinel.
      const { actualNumChunks, segmentDurationsSec: newDurations } = await encodeChunksToGcs(
        gameId, ownerId, srcPath, workDir,
        existFlags, firstMissing,
        /* deleteAfterUpload */ true,
        /* signal */ undefined,
        /* maxDurationSec */ undefined, // encode ALL chunks, no early stop
      );
      // Prepend approximate durations for any chunks that were already in GCS
      // (indices 0..firstMissing-1 — we didn't encode them locally so we can't
      // ffprobe them).  Use PROXY_CHUNK_DURATION_SEC as the approximation.
      const allDurations = [
        ...Array<number>(firstMissing).fill(PROXY_CHUNK_DURATION_SEC),
        ...newDurations,
      ];
      // Write the sentinel AFTER all chunks are safely in GCS.  The sentinel
      // is the only signal getReadyProxyChunkCount trusts, so it must not be
      // written until the encode is complete and uploaded.
      await writeHlsSentinel(ownerId, gameId, actualNumChunks, allDurations);
      logger.info({ gameId, actualNumChunks }, "HLS chunk build: complete — sentinel written");
    } finally {
      release();
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  })()
    .catch((err) => logger.error({ err, gameId }, "HLS chunk build: failed"))
    .finally(() => backgroundHlsBuilds.delete(gameId));
}

// ---------------------------------------------------------------------------
// HLS build-completion sentinel
//
// The sentinel is a small JSON object uploaded to GCS by
// ensureAllProxyChunksInBackground after encodeChunksToGcs returns.  It
// records the EXACT chunk count produced by the encoder — not a duration
// estimate — so getReadyProxyChunkCount never returns the wrong count.
//
// Why a sentinel instead of probing GCS chunk existence?
//   • Duration-estimated chunk counts can be wrong in either direction.
//   • Underestimate: the source is longer than videoDurationMs says, so extra
//     chunks are produced that the estimate doesn't cover — probing stops
//     too early and returns a truncated count.
//   • Overestimate: the source is shorter, so estimated tail chunks never
//     exist — probing sees a gap and returns -1 forever, restarting the job
//     on every poll and never enabling playback.
//   • The sentinel path embeds PROXY_VERSION so a codec change automatically
//     invalidates old sentinels.
// ---------------------------------------------------------------------------

/** GCS path for the HLS build-completion sentinel for a game. */
function makeHlsSentinelGcsPath(ownerId: number, gameId: number): string {
  return `/objects/uploads/${ownerId}/proxy_hls_done_v${PROXY_VERSION}_${gameId}.json`;
}

/**
 * Shape of the HLS build-completion sentinel stored in GCS.
 * `segmentDurationsSec[i]` is the actual duration of chunk i as probed by
 * ffprobe immediately after the encoder wrote each local file.  This value
 * is used verbatim in `#EXTINF` so AVPlayer's seek table is accurate.
 */
export interface HlsSentinel {
  chunkCount: number;
  /** Actual ffprobe-measured duration (seconds) for each chunk, in order. */
  segmentDurationsSec: number[];
}

/**
 * Upload the build-completion sentinel to GCS.  Must be called AFTER all
 * proxy chunks are safely in GCS so the sentinel is always consistent.
 *
 * `segmentDurationsSec` must have exactly `chunkCount` entries.  For chunks
 * that were already in GCS before this encode run (indices 0..firstMissing-1),
 * pass PROXY_CHUNK_DURATION_SEC as the approximation — only newly encoded
 * chunks have exact ffprobe measurements.
 */
async function writeHlsSentinel(
  ownerId: number,
  gameId: number,
  chunkCount: number,
  segmentDurationsSec: number[],
): Promise<void> {
  const sentinel: HlsSentinel = { chunkCount, segmentDurationsSec };
  const tmpFile = path.join(os.tmpdir(), `hls_sentinel_${gameId}_${Date.now()}.json`);
  await fs.writeFile(tmpFile, JSON.stringify(sentinel));
  try {
    await objectStorageService.uploadLocalFileToObjectPath(
      tmpFile,
      makeHlsSentinelGcsPath(ownerId, gameId),
      "application/json",
    );
  } finally {
    await fs.unlink(tmpFile).catch(() => {});
  }
}

/**
 * Read the HLS build-completion sentinel from GCS and return its parsed data,
 * or null if the sentinel does not exist or is corrupt.
 *
 * The playlist route uses this to emit exact `#EXTINF` values and
 * `#EXT-X-TARGETDURATION` — no duration estimates, no GCS chunk probing.
 */
export async function readHlsSentinel(
  ownerId: number,
  gameId: number,
): Promise<HlsSentinel | null> {
  try {
    const file = await objectStorageService.getObjectEntityFile(
      makeHlsSentinelGcsPath(ownerId, gameId),
    );
    const [buf] = await file.download();
    const parsed = JSON.parse(buf.toString()) as Partial<HlsSentinel>;
    if (
      typeof parsed.chunkCount === "number" &&
      parsed.chunkCount > 0 &&
      Array.isArray(parsed.segmentDurationsSec) &&
      parsed.segmentDurationsSec.length === parsed.chunkCount &&
      parsed.segmentDurationsSec.every((d) => typeof d === "number")
    ) {
      return { chunkCount: parsed.chunkCount, segmentDurationsSec: parsed.segmentDurationsSec };
    }
  } catch {
    // Sentinel absent or corrupt — build not yet complete (or not started).
  }
  return null;
}

/**
 * Returns the chunk count from the GCS sentinel, or -1 if not ready.
 * Delegates entirely to readHlsSentinel — no duration estimation.
 * `durationMs` is kept for call-site compatibility but is not used.
 */
export async function getReadyProxyChunkCount(
  gameId: number,
  ownerId: number,
  _durationMs: number,
): Promise<number> {
  const sentinel = await readHlsSentinel(ownerId, gameId);
  return sentinel?.chunkCount ?? -1;
}

const backgroundHlsBuilds = new Set<number>();

/**
 * Download the GCS proxy chunk at `chunkGcsPath` to a local temp file
 * (ref-counted; shared with concurrent callers) and return its local path
 * plus a release function that must be called when done.
 */
export async function acquireProxyChunkLocally(
  chunkGcsPath: string,
): Promise<{ localPath: string; release: () => Promise<void> }> {
  const localPath = await _acquireSharedChunk(chunkGcsPath);
  return { localPath, release: () => _releaseSharedChunk(chunkGcsPath) };
}
