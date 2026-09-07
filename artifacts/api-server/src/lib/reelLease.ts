import { randomUUID } from "node:crypto";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { db, gamesTable } from "@workspace/db";

export type ReelKind = "highlight" | "lowlight";

export const REEL_LEASE_MS = 10 * 60 * 1000;

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
  startedAt: Date;
  leaseExpiresAt: Date;
}

export async function claimReelLease(
  gameId: number,
  kind: ReelKind,
  extra: Record<string, unknown> = {},
  now?: Date,
): Promise<ReelLease | null> {
  const token = randomUUID();
  const startedAtValue = now ?? sql<Date>`NOW()`;
  const leaseExpiresAtValue = now
    ? new Date(now.getTime() + REEL_LEASE_MS)
    : sql<Date>`NOW() + INTERVAL '10 minutes'`;
  const c = columnsFor(kind);
  const values = kind === "highlight"
    ? {
        highlightStatus: "processing",
        highlightStartedAt: startedAtValue,
        highlightRunToken: token,
        highlightLeaseExpiresAt: leaseExpiresAtValue,
        ...extra,
      }
    : {
        lowlightStatus: "processing",
        lowlightStartedAt: startedAtValue,
        lowlightRunToken: token,
        lowlightLeaseExpiresAt: leaseExpiresAtValue,
        ...extra,
      };
  const rows = await db
    .update(gamesTable)
    .set(values)
    .where(
      and(
        eq(gamesTable.id, gameId),
        or(
          sql`${c.status} IS DISTINCT FROM 'processing'`,
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
  if (!claimed?.startedAt || !claimed.leaseExpiresAt) return null;
  return {
    token,
    startedAt: claimed.startedAt,
    leaseExpiresAt: claimed.leaseExpiresAt,
  };
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
    .where(and(eq(gamesTable.id, gameId), eq(c.status, "processing"), eq(c.token, token)))
    .returning({ id: gamesTable.id });
  return rows.length > 0;
}

export async function updateReelIfOwner(
  gameId: number,
  kind: ReelKind,
  token: string,
  values: Record<string, unknown>,
): Promise<boolean> {
  const c = columnsFor(kind);
  const rows = await db
    .update(gamesTable)
    .set(values)
    .where(
      and(
        eq(gamesTable.id, gameId),
        eq(c.status, "processing"),
        eq(c.token, token),
      ),
    )
    .returning({ id: gamesTable.id });
  return rows.length > 0;
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
        highlightRunToken: null,
        highlightLeaseExpiresAt: null,
      }
    : {
        lowlightStatus: null,
        lowlightError: null,
        lowlightObjectPath: null,
        lowlightStartedAt: null,
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