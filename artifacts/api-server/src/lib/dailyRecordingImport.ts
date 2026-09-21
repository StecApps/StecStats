import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  gamesTable,
  liveRecordingJobsTable,
  liveSessionsTable,
} from "@workspace/db";
import { ObjectStorageService } from "./objectStorage";
import {
  getDailyRecording,
  listDailyRecordings,
  downloadDailyRecording,
  stopDailyRecording,
  type DailyRecording,
} from "./daily";
import { scheduleVideoDurationProbe } from "./videoDuration";
import { retainGameMasterFilm } from "./gameFilmRetention";
import { logger } from "./logger";
import { generateHighlight, generateLowlight, countLowlightMoments } from "./highlightGenerator";
import { launchReelJob } from "./reelLease";

const LEASE_MS = 5 * 60 * 1000;
const POLL_MS = 30 * 1000;
let timer: NodeJS.Timeout | undefined;
let running = false;

const highlightRunner = { generate: generateHighlight, cancelRun: () => {} };
const lowlightRunner = { generate: generateLowlight, cancelRun: () => {} };

export async function enqueueDailyRecordingImport(input: {
  liveSessionId: number;
  gameId: number;
  ownerId: number;
  dailyRoomName: string;
  dailyRecordingId?: string | null;
}): Promise<void> {
  await db.insert(liveRecordingJobsTable).values({
    ...input,
    dailyRecordingId: input.dailyRecordingId ?? null,
    status: "queued",
  }).onConflictDoNothing();
}

async function claimJob() {
  const token = randomUUID();
  const rows = await db.execute(sql`
    UPDATE live_recording_jobs
    SET status = 'processing',
        lease_token = ${token},
        lease_expires_at = NOW() + INTERVAL '5 minutes',
        attempts = attempts + 1,
        updated_at = NOW()
    WHERE id = (
      SELECT id FROM live_recording_jobs
      WHERE status IN ('queued', 'processing')
        AND next_attempt_at <= NOW()
        AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
      ORDER BY id
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, live_session_id, game_id, owner_id, daily_room_name,
      daily_recording_id, object_path, lease_token
  `);
  return (rows.rows[0] as {
    id: number; live_session_id: number; game_id: number; owner_id: number;
    daily_room_name: string; daily_recording_id: string | null; object_path: string | null; lease_token: string;
  } | undefined);
}

async function failJob(job: { id: number; lease_token: string }, error: unknown): Promise<void> {
  await db.update(liveRecordingJobsTable).set({
    status: "queued",
    lastError: error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
    nextAttemptAt: new Date(Date.now() + 60_000),
    leaseToken: null,
    leaseExpiresAt: null,
    updatedAt: new Date(),
  }).where(and(eq(liveRecordingJobsTable.id, job.id), eq(liveRecordingJobsTable.leaseToken, job.lease_token)));
}

async function processJob(job: NonNullable<Awaited<ReturnType<typeof claimJob>>>): Promise<void> {
  const heartbeat = setInterval(() => {
    void db.update(liveRecordingJobsTable).set({
      leaseExpiresAt: new Date(Date.now() + LEASE_MS),
      updatedAt: new Date(),
    }).where(and(
      eq(liveRecordingJobsTable.id, job.id),
      eq(liveRecordingJobsTable.leaseToken, job.lease_token),
    )).catch((error) => logger.warn({ err: error, jobId: job.id }, "Daily import lease heartbeat failed"));
  }, Math.max(10_000, Math.floor(LEASE_MS / 2)));
  heartbeat.unref();
  const assertLease = async (): Promise<void> => {
    const rows = await db.select({ id: liveRecordingJobsTable.id })
      .from(liveRecordingJobsTable)
      .where(and(eq(liveRecordingJobsTable.id, job.id), eq(liveRecordingJobsTable.leaseToken, job.lease_token)))
      .limit(1);
    if (!rows[0]) throw new Error("Daily recording import lease was lost");
  };
  try {
  let recording: DailyRecording | undefined;
  if (job.daily_recording_id) {
    recording = await getDailyRecording(job.daily_recording_id);
  } else {
    const recordings = await listDailyRecordings(job.daily_room_name);
    recording = recordings
      .filter((item) => item.status === "finished")
      .sort((a, b) => (b.start_ts ?? 0) - (a.start_ts ?? 0))[0];
    if (!recording) {
      // A client or an earlier server path may have marked the session stopped
      // without Daily receiving the stop command. Repeating the idempotent stop
      // here guarantees that a queued game eventually gets a finalized master.
      await stopDailyRecording(job.daily_room_name);
      throw new Error("Daily recording is not finalized yet");
    }
    await db.update(liveRecordingJobsTable).set({
      dailyRecordingId: recording.id,
      updatedAt: new Date(),
    }).where(and(eq(liveRecordingJobsTable.id, job.id), eq(liveRecordingJobsTable.leaseToken, job.lease_token)));
  }
  await assertLease();
  await db.update(liveSessionsTable).set({
    dailyRecordingId: recording.id,
    dailyRecordingStatus: "finished",
  }).where(eq(liveSessionsTable.id, job.live_session_id));
  if (!recording || (recording.status && recording.status !== "finished")) {
    throw new Error("Daily recording is not finalized yet");
  }

  await assertLease();
  let objectPath = job.object_path;
  if (!objectPath) {
    const response = await downloadDailyRecording(recording);
    const contentType = response.headers.get("content-type")?.split(";")[0] || "video/mp4";
    objectPath = await new ObjectStorageService().uploadReadableStreamAsObjectEntity(
      response.body!,
      job.owner_id,
      contentType,
    );
    await db.update(liveRecordingJobsTable).set({
      objectPath,
      updatedAt: new Date(),
    }).where(and(eq(liveRecordingJobsTable.id, job.id), eq(liveRecordingJobsTable.leaseToken, job.lease_token)));
  }
  await assertLease();

  const game = await db.query.gamesTable.findFirst({
    where: and(eq(gamesTable.id, job.game_id), eq(gamesTable.ownerId, job.owner_id)),
  });
  if (!game) throw new Error("Game is missing or is not owned by broadcaster");
  if (game.videoObjectPath !== objectPath) {
    await db.transaction(async (tx) => {
      await retainGameMasterFilm(tx, job.owner_id, game.id, objectPath);
      await tx.update(gamesTable).set({
        videoObjectPath: objectPath,
        videoDurationMs: null,
        highlightStatus: "idle",
        lowlightStatus: "idle",
      }).where(and(eq(gamesTable.id, game.id), eq(gamesTable.ownerId, job.owner_id)));
    });
    scheduleVideoDurationProbe(game.id, objectPath);
  }

  await assertLease();
  // Reel launch is intentionally before completion: retries are safe because the
  // lease-backed reel jobs are themselves idempotent.
  await launchReelJob(job.game_id, "highlight", {}, undefined, highlightRunner);
  if (await countLowlightMoments(job.game_id) > 0) {
    await launchReelJob(job.game_id, "lowlight", {}, undefined, lowlightRunner);
  }
  await db.update(liveRecordingJobsTable).set({
    status: "complete",
    objectPath,
    leaseToken: null,
    leaseExpiresAt: null,
    updatedAt: new Date(),
  }).where(and(eq(liveRecordingJobsTable.id, job.id), eq(liveRecordingJobsTable.leaseToken, job.lease_token)));

  logger.info({ gameId: job.game_id, objectPath }, "Daily recording imported and reel jobs queued");
  } finally {
    clearInterval(heartbeat);
  }
}

async function pollOnce(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const job = await claimJob();
    if (!job) return;
    try {
      await processJob(job);
    } catch (error) {
      logger.warn({ err: error, jobId: job.id }, "Daily recording import will retry");
      await failJob(job, error);
    }
  } finally {
    running = false;
  }
}

export function startDailyRecordingImportWorker(): void {
  if (timer) return;
  void pollOnce();
  timer = setInterval(() => void pollOnce(), POLL_MS);
  timer.unref();
}