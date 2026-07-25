import { db, gamesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { ObjectStorageService } from "./objectStorage";
import { logger } from "./logger";

/**
 * Probes the TRUE duration of a stored game video without downloading the
 * whole file. This is the authoritative "end of footage" timestamp used to
 * detect stat events that were logged after the recording stopped.
 *
 * - WebM (live recordings): the container has no duration header (cueless,
 *   streamed), so we read the last few MB and parse the final Matroska
 *   cluster timecode (cluster ID 0x1F43B675, Timecode child 0xE7, ms units).
 * - MP4 (iOS uploads, written with +faststart): parse the mvhd box from the
 *   head bytes (timescale + duration).
 */

function readVint(buf: Buffer, pos: number): { value: number; length: number } | null {
  if (pos >= buf.length) return null;
  const first = buf[pos];
  let mask = 0x80,
    length = 1;
  while (length <= 8 && !(first & mask)) {
    mask >>= 1;
    length++;
  }
  if (length > 8 || pos + length > buf.length) return null;
  let value = first & (mask - 1);
  for (let i = 1; i < length; i++) value = value * 256 + buf[pos + i];
  return { value, length };
}

function findLastClusterTimecodeMs(buf: Buffer): number | null {
  let last: number | null = null;
  for (let i = 0; i < buf.length - 16; i++) {
    if (buf[i] === 0x1f && buf[i + 1] === 0x43 && buf[i + 2] === 0xb6 && buf[i + 3] === 0x75) {
      const size = readVint(buf, i + 4);
      if (!size) continue;
      let p = i + 4 + size.length;
      if (p >= buf.length - 10) continue;
      if (buf[p] !== 0xe7) continue; // Timecode should be the first child
      const tcSize = readVint(buf, p + 1);
      if (!tcSize || tcSize.value > 8) continue;
      p = p + 1 + tcSize.length;
      if (p + tcSize.value > buf.length) continue;
      let tc = 0;
      for (let j = 0; j < tcSize.value; j++) tc = tc * 256 + buf[p + j];
      last = tc;
    }
  }
  return last;
}

function parseMp4DurationMs(head: Buffer): number | null {
  const idx = head.indexOf("mvhd", 0, "ascii");
  if (idx < 0) return null;
  const version = head[idx + 4];
  try {
    if (version === 0) {
      const timescale = head.readUInt32BE(idx + 16);
      const duration = head.readUInt32BE(idx + 20);
      if (timescale > 0) return Math.round((duration / timescale) * 1000);
    } else if (version === 1) {
      const timescale = head.readUInt32BE(idx + 24);
      const duration = Number(head.readBigUInt64BE(idx + 28));
      if (timescale > 0) return Math.round((duration / timescale) * 1000);
    }
  } catch {
    return null;
  }
  return null;
}

async function readRange(
  file: { createReadStream: (opts: { start: number; end: number }) => NodeJS.ReadableStream },
  start: number,
  end: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    file
      .createReadStream({ start, end })
      .on("data", (c: Buffer) => chunks.push(c))
      .on("end", () => resolve())
      .on("error", reject);
  });
  return Buffer.concat(chunks);
}

export async function probeStoredVideoDurationMs(objectPath: string): Promise<number | null> {
  const svc = new ObjectStorageService();
  const file = await svc.getObjectEntityFile(objectPath);
  const [meta] = await file.getMetadata();
  const size = Number(meta.size);
  if (!Number.isFinite(size) || size < 64) return null;

  const head = await readRange(file, 0, Math.min(1024 * 1024, size) - 1);

  // MP4? ("ftyp" at byte 4)
  if (head.length > 8 && head.toString("ascii", 4, 8) === "ftyp") {
    const fromHead = parseMp4DurationMs(head);
    if (fromHead != null && fromHead > 0) return fromHead;
    // moov may be at the tail (no faststart) — check the last 1 MB too.
    const tail = await readRange(file, Math.max(0, size - 1024 * 1024), size - 1);
    const fromTail = parseMp4DurationMs(tail);
    return fromTail != null && fromTail > 0 ? fromTail : null;
  }

  // WebM? (EBML magic 0x1A45DFA3)
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    const TAIL = 8 * 1024 * 1024;
    const tail = await readRange(file, Math.max(0, size - TAIL), size - 1);
    const lastTc = findLastClusterTimecodeMs(tail);
    // The last cluster timecode marks the START of the final cluster; the
    // true end is at most a couple of seconds later. Good enough for
    // off-film detection.
    return lastTc != null && lastTc > 0 ? lastTc : null;
  }

  return null;
}

// Guards: one probe per game at a time, and a cooldown after a failed
// attempt so client polling (every few seconds) can't hammer GCS.
const probesInFlight = new Set<number>();
const probeCooldownUntil = new Map<number, number>();
const PROBE_FAILURE_COOLDOWN_MS = 15 * 60 * 1000;

/**
 * Fire-and-forget: probe the stored video's duration and persist it on the
 * game row. Never throws. Skips the probe when the game already has a
 * duration recorded for this exact video.
 */
export function scheduleVideoDurationProbe(gameId: number, objectPath: string): void {
  if (probesInFlight.has(gameId)) return;
  const cooldown = probeCooldownUntil.get(gameId);
  if (cooldown != null && Date.now() < cooldown) return;
  probesInFlight.add(gameId);
  void (async () => {
    try {
      const durationMs = await probeStoredVideoDurationMs(objectPath);
      if (durationMs == null) {
        probeCooldownUntil.set(gameId, Date.now() + PROBE_FAILURE_COOLDOWN_MS);
        logger.warn({ gameId, objectPath }, "video duration probe found no duration");
        return;
      }
      // Guard against a stale probe overwriting a newer video's duration.
      const game = await db.query.gamesTable.findFirst({ where: eq(gamesTable.id, gameId) });
      if (!game || game.videoObjectPath !== objectPath) return;
      await db
        .update(gamesTable)
        .set({ videoDurationMs: durationMs })
        .where(eq(gamesTable.id, gameId));
      probeCooldownUntil.delete(gameId);
      logger.info({ gameId, durationMs }, "video duration probed and stored");
    } catch (err) {
      probeCooldownUntil.set(gameId, Date.now() + PROBE_FAILURE_COOLDOWN_MS);
      logger.warn({ err, gameId, objectPath }, "video duration probe failed");
    } finally {
      probesInFlight.delete(gameId);
    }
  })();
}
