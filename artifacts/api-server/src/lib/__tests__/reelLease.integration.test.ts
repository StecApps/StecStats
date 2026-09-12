import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { db, gamesTable, pool, teamsTable } from "@workspace/db";
import { claimReelLease, updateReelIfOwner, type ReelKind } from "../reelLease";

let teamId: number;
const gameIds: number[] = [];

beforeAll(async () => {
  const [team] = await db
    .insert(teamsTable)
    .values({ name: "Reel lease concurrency test", sport: "basketball" })
    .returning({ id: teamsTable.id });
  teamId = team.id;
});


afterAll(async () => {
  for (const gameId of gameIds) {
    await db.delete(gamesTable).where(eq(gamesTable.id, gameId));
  }
  if (teamId) {
    await db.delete(teamsTable).where(eq(teamsTable.id, teamId));
  }
});

async function createExpiredLease(kind: ReelKind) {
  const expiredAt = new Date(Date.now() - 60_000);
  const oldToken = crypto.randomUUID();
  const values =
    kind === "highlight"
      ? {
          highlightStatus: "processing",
          highlightRunToken: oldToken,
          highlightStartedAt: new Date(expiredAt.getTime() - 60_000),
          highlightLeaseExpiresAt: expiredAt,
        }
      : {
          lowlightStatus: "processing",
          lowlightRunToken: oldToken,
          lowlightStartedAt: new Date(expiredAt.getTime() - 60_000),
          lowlightLeaseExpiresAt: expiredAt,
        };
  const [game] = await db
    .insert(gamesTable)
    .values({
      teamId,
      opponent: "Lease rival",
      date: "2026-09-07",
      result: "W",
      teamScore: 1,
      opponentScore: 0,
      ...values,
    })
    .returning({ id: gamesTable.id });
  gameIds.push(game.id);
  return { gameId: game.id, oldToken };
}

describe("PostgreSQL reel lease concurrency", () => {
  it.each(["highlight", "lowlight"] as const)(
    "allows exactly one server to take over an expired %s lease and fences the old server",
    async (kind) => {
      const { gameId, oldToken } = await createExpiredLease(kind);
      const clientA = await pool.connect();
      const clientB = await pool.connect();

      try {
        const serverA = drizzle(clientA);
        const serverB = drizzle(clientB);
        const [claimA, claimB] = await Promise.all([
          claimReelLease(gameId, kind, {}, undefined, serverA),
          claimReelLease(gameId, kind, {}, undefined, serverB),
        ]);

        const claims = [claimA, claimB].filter(
          (claim): claim is NonNullable<typeof claim> => claim !== null,
        );
        expect(claims).toHaveLength(1);
        expect(claims[0].token).not.toBe(oldToken);

        expect(
          await updateReelIfOwner(
            gameId,
            kind,
            oldToken,
            { [`${kind}Status`]: "ready" },
            serverA,
          ),
        ).toBe(false);
        expect(
          await updateReelIfOwner(
            gameId,
            kind,
            oldToken,
            { [`${kind}Status`]: "failed" },
            serverB,
          ),
        ).toBe(false);
        expect(
          await updateReelIfOwner(
            gameId,
            kind,
            oldToken,
            { [`${kind}ObjectPath`]: `/stale-${kind}.mp4` },
            serverA,
          ),
        ).toBe(false);

        const [stored] = await db
          .select()
          .from(gamesTable)
          .where(eq(gamesTable.id, gameId));
        expect(stored[`${kind}Status`]).toBe("queued");
        expect(
          kind === "highlight"
            ? stored.highlightRunToken
            : stored.lowlightRunToken,
        ).toBe(claims[0].token);
        expect(stored[`${kind}ObjectPath`]).toBeNull();
      } finally {
        clientA.release();
        clientB.release();
      }
    },
  );
});