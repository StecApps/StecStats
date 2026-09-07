import { randomUUID } from "node:crypto";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { db, gamesTable } from "@workspace/db";

export type ReelKind = "highlight" | "lowlight";
type ReelLeaseDb = Pick<typeof db, "update">;

export const REEL_LEASE_MS = 10 * 60 * 1000;
const REEL_JOB_TIMEOUT_MS = 130 * 60 * 1000;
const inFlightReelJobs = new Map<string, string>();

export interface ReelJobRunner {
  generate: (gameId: number, musicTrackPath: string | undefined, token: string) => Promise<void>;
  cancelRun: (gameId: number, token: string) => void;
}

function reelJobKey(gameId: number, kind: ReelKind): string {
  return `${kind}:${gameId}`;
}

function timeoutFailureValues(kind: ReelKind): Record<string, unknown> {
  return kind === "highlight"
    ? {
        highlightStatus: "failed",
        highlightError: "Generation timed out — tap Try Again to rebuild.",
        highlightRunToken: null,
        highlightLeaseExpiresAt: null,
        highlightClipManifest: null,
        highlightPlaybackVersion: null,
        highlightProgressStage: null,
        highlightProgressCompleted: null,
        highlightProgressTotal: null,
      }
    : {
        lowlightStatus: "failed",
        lowlightError: "Generation timed out — tap Try Again to rebuild.",
        lowlightRunToken: null,
        lowlightLeaseExpiresAt: null,
        lowlightProgressStage: null,
        lowlightProgressCompleted: null,
        lowlightProgressTotal: null,
      };
}

function runClaimedReelJob(
  gameId: number,
  kind: ReelKind,
  token: string,
  musicTrackPath: string | undefined,
  runner: ReelJobRunner,
): void {
  const key = reelJobKey(gameId, kind);
  inFlightReelJobs.set(key, token);
  let watchdog: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((_, reject) => {
    watchdog = setTimeout(() => reject(new Error("timeout")), REEL_JOB_TIMEOUT_MS);
    watchdog.unref();
  });

  const generation = Promise.resolve().then(() =>
    runner.generate(gameId, musicTrackPath, token),
  );
  void Promise.race([generation, timeout])
    .catch(async (error) => {
      if ((error as Error)?.message !== "timeout") return;
      try {
        await updateReelIfOwner(gameId, kind, token, timeoutFailureValues(kind));
      } catch {
        // The watchdog is best-effort; token fencing still prevents stale publication.
      } finally {
        runner.cancelRun(gameId, token);
      }
    })
    .finally(() => {
      if (watchdog) clearTimeout(watchdog);
      if (inFlightReelJobs.get(key) === token) {
        inFlightReelJobs.delete(key);
      }
    });
}

export async function launchReelJob(
  gameId: number,
  kind: ReelKind,
  extra: Record<string, unknown>,
  musicTrackPath: string | undefined,
  runner: ReelJobRunner,
): Promise<ReelLease | null> {
  const lease = await claimReelLease(gameId, kind, extra);
  if (lease) {
    runClaimedReelJob(gameId, kind, lease.token, musicTrackPath, runner);
  }
  return lease;
}

export async function resumeReelJob(
  gameId: number,
  kind: ReelKind,
  runner: ReelJobRunner,
): Promise<void> {
  if (inFlightReelJobs.has(reelJobKey(gameId, kind))) return;
  const lease = await claimReelLease(gameId, kind);
  if (lease) {
    runClaimedReelJob(gameId, kind, lease.token, undefined, runner);
  }
}

export async function cancelReelJob(
  gameId: number,
  kind: ReelKind,
  cancelAllRuns: (gameId: number) => void,
  values: Record<string, unknown>,
): Promise<void> {
  cancelAllRuns(gameId);
  inFlightReelJobs.delete(reelJobKey(gameId, kind));
  await invalidateReelLease(gameId, kind, values);
}

function columnsFor(kind: ReelKind) {
  return kind === "highlight"
    ? {
        status: gamesTable.highlightStatus,
        token: gamesTable.highlightRunToken,
        leaseExpiresAt: gamesTable.highlightLeaseExpiresAt,
        generatorVersion: gamesTable.highlightGeneratorVersion,
      }
    : {
        status: gamesTable.lowlightStatus,
        token: gamesTable.lowlightRunToken,
        leaseExpiresAt: gamesTable.lowlightLeaseExpiresAt,
        generatorVersion: gamesTable.lowlightGeneratorVersion,
      };
}

export interface ReelLease {
  token: string;
  startedAt: Date | null;
  leaseExpiresAt: Date;
}

export async function claimReelLease(
  gameId: number,
  kind: ReelKind,
  extra: Record<string, unknown> = {},
  now?: Date,
  database: ReelLeaseDb = db,
): Promise<ReelLease | null> {
  const token = randomUUID();
  const startedAtValue = now ?? sql<Date>`NOW()`;
  const leaseExpiresAtValue = now
    ? new Date(now.getTime() + REEL_LEASE_MS)
    : sql<Date>`NOW() + INTERVAL '10 minutes'`;
  const c = columnsFor(kind);
  const values = kind === "highlight"
    ? {
        highlightStatus: "queued",
        highlightStartedAt: null,
        highlightRunToken: token,
        highlightLeaseExpiresAt: leaseExpiresAtValue,
        highlightClipManifest: null,
        highlightPlaybackVersion: null,
        highlightProgressStage: null,
        highlightProgressCompleted: null,
        highlightProgressTotal: null,
        ...extra,
      }
    : {
        lowlightStatus: "queued",
        lowlightStartedAt: null,
        lowlightRunToken: token,
        lowlightLeaseExpiresAt: leaseExpiresAtValue,
        lowlightProgressStage: null,
        lowlightProgressCompleted: null,
        lowlightProgressTotal: null,
        ...extra,
      };
  const rows = await database
    .update(gamesTable)
    .set(values)
    .where(
      and(
        eq(gamesTable.id, gameId),
        or(
          and(
            sql`${c.status} IS DISTINCT FROM 'queued'`,
            sql`${c.status} IS DISTINCT FROM 'processing'`,
          ),
          sql`${c.token} IS NULL`,
          sql`${c.leaseExpiresAt} IS NULL`,
          now ? lt(c.leaseExpiresAt, now) : sql`${c.leaseExpiresAt} < NOW()`,
        ),
      ),
    )
    .returning(
      kind === "highlight"
        ? {
            startedAt: gamesTable.highlightStartedAt,
            leaseExpiresAt: gamesTable.highlightLeaseExpiresAt,
          }
        : {
            startedAt: gamesTable.lowlightStartedAt,
            leaseExpiresAt: gamesTable.lowlightLeaseExpiresAt,
          },
    );
  const claimed = rows[0];
  if (!claimed?.leaseExpiresAt) return null;
  return {
    token,
    startedAt: claimed.startedAt ?? null,
    leaseExpiresAt: claimed.leaseExpiresAt,
  };
}

export async function markReelEncodingStarted(
  gameId: number,
  kind: ReelKind,
  token: string,
): Promise<boolean> {
  const c = columnsFor(kind);
  const values = kind === "highlight"
    ? {
        highlightStatus: "processing",
        highlightStartedAt: sql<Date>`NOW()`,
      }
    : {
        lowlightStatus: "processing",
        lowlightStartedAt: sql<Date>`NOW()`,
      };
  const rows = await db
    .update(gamesTable)
    .set(values)
    .where(
      and(
        eq(gamesTable.id, gameId),
        or(eq(c.status, "queued"), eq(c.status, "processing")),
        eq(c.token, token),
      ),
    )
    .returning({ id: gamesTable.id });
  return rows.length > 0;
}

export async function renewReelLease(
  gameId: number,
  kind: ReelKind,
  token: string,
  now?: Date,
): Promise<boolean> {
  const c = columnsFor(kind);
  const leaseExpiresAt = now
    ? new Date(now.getTime() + REEL_LEASE_MS)
    : sql<Date>`NOW() + INTERVAL '10 minutes'`;
  const values = kind === "highlight"
    ? { highlightLeaseExpiresAt: leaseExpiresAt }
    : { lowlightLeaseExpiresAt: leaseExpiresAt };
  const rows = await db
    .update(gamesTable)
    .set(values)
    .where(
      and(
        eq(gamesTable.id, gameId),
        or(eq(c.status, "queued"), eq(c.status, "processing")),
        eq(c.token, token),
      ),
    )
    .returning({ id: gamesTable.id });
  return rows.length > 0;
}

export async function updateReelIfOwner(
  gameId: number,
  kind: ReelKind,
  token: string,
  values: Record<string, unknown>,
  database: ReelLeaseDb = db,
): Promise<boolean> {
  const c = columnsFor(kind);
  const rows = await database
    .update(gamesTable)
    .set(values)
    .where(
      and(
        eq(gamesTable.id, gameId),
        or(eq(c.status, "queued"), eq(c.status, "processing")),
        eq(c.token, token),
      ),
    )
    .returning({ id: gamesTable.id });
  return rows.length > 0;
}

export type ReelProgressStage = "proxy" | "clips" | "finalizing";

export async function updateReelProgressIfOwner(
  gameId: number,
  kind: ReelKind,
  token: string,
  stage: ReelProgressStage,
  completed: number,
  total: number,
  database: ReelLeaseDb = db,
): Promise<boolean> {
  const safeTotal = Math.max(0, Math.trunc(total));
  const safeCompleted = Math.min(safeTotal, Math.max(0, Math.trunc(completed)));
  return updateReelIfOwner(
    gameId,
    kind,
    token,
    kind === "highlight"
      ? {
          highlightProgressStage: stage,
          highlightProgressCompleted: safeCompleted,
          highlightProgressTotal: safeTotal,
        }
      : {
          lowlightProgressStage: stage,
          lowlightProgressCompleted: safeCompleted,
          lowlightProgressTotal: safeTotal,
        },
    database,
  );
}

export async function invalidateReelLease(
  gameId: number,
  kind: ReelKind,
  values: Record<string, unknown>,
): Promise<void> {
  const c = columnsFor(kind);
  const invalidated = kind === "highlight"
    ? { ...values, highlightRunToken: null, highlightLeaseExpiresAt: null }
    : { ...values, lowlightRunToken: null, lowlightLeaseExpiresAt: null };
  await db.update(gamesTable).set({
    ...invalidated,
  }).where(eq(gamesTable.id, gameId));
}

export async function invalidateOutdatedReadyReel(
  gameId: number,
  kind: ReelKind,
  currentGeneratorVersion: number,
): Promise<boolean> {
  const c = columnsFor(kind);
  const values = kind === "highlight"
    ? {
        highlightStatus: null,
        highlightError: null,
        highlightObjectPath: null,
        highlightStartedAt: null,
        highlightProgressStage: null,
        highlightProgressCompleted: null,
        highlightProgressTotal: null,
        highlightRunToken: null,
        highlightLeaseExpiresAt: null,
        highlightClipManifest: null,
        highlightPlaybackVersion: null,
      }
    : {
        lowlightStatus: null,
        lowlightError: null,
        lowlightObjectPath: null,
        lowlightStartedAt: null,
        lowlightProgressStage: null,
        lowlightProgressCompleted: null,
        lowlightProgressTotal: null,
        lowlightRunToken: null,
        lowlightLeaseExpiresAt: null,
      };
  const rows = await db
    .update(gamesTable)
    .set(values)
    .where(
      and(
        eq(gamesTable.id, gameId),
        eq(c.status, "ready"),
        or(isNull(c.generatorVersion), lt(c.generatorVersion, currentGeneratorVersion)),
      ),
    )
    .returning({ id: gamesTable.id });
  return rows.length > 0;
}

export function startReelLeaseHeartbeat(
  gameId: number,
  kind: ReelKind,
  token: string,
  onLeaseLost: () => void,
): () => void {
  let consecutiveErrors = 0;
  const timer = setInterval(() => {
    void renewReelLease(gameId, kind, token)
      .then((renewed) => {
        consecutiveErrors = 0;
        if (!renewed) {
          clearInterval(timer);
          onLeaseLost();
        }
      })
      .catch(() => {
        consecutiveErrors += 1;
        if (consecutiveErrors >= 2) {
          clearInterval(timer);
          onLeaseLost();
        }
      });
  }, REEL_LEASE_MS / 3);
  timer.unref();
  return () => clearInterval(timer);
}