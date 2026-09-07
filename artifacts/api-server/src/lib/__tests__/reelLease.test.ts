import { beforeEach, describe, expect, it, vi } from "vitest";

type Predicate =
  | { op: "eq" | "lt"; field: string; value: unknown }
  | { op: "and" | "or"; children: Predicate[] }
  | { op: "distinct"; field: string; value: unknown }
  | { op: "isNull"; field: string };

const { row, gamesTable, updateMock } = vi.hoisted(() => {
  const gamesTable = {
    id: "id",
    highlightStatus: "highlightStatus",
    highlightStartedAt: "highlightStartedAt",
    highlightRunToken: "highlightRunToken",
    highlightLeaseExpiresAt: "highlightLeaseExpiresAt",
    highlightGeneratorVersion: "highlightGeneratorVersion",
    lowlightStatus: "lowlightStatus",
    lowlightStartedAt: "lowlightStartedAt",
    lowlightRunToken: "lowlightRunToken",
    lowlightLeaseExpiresAt: "lowlightLeaseExpiresAt",
    lowlightGeneratorVersion: "lowlightGeneratorVersion",
  };
  const row = { value: {} as Record<string, unknown> };

  function matches(predicate: Predicate): boolean {
    if (predicate.op === "and") return predicate.children.every(matches);
    if (predicate.op === "or") return predicate.children.some(matches);
    if (predicate.op === "distinct") return row.value[predicate.field] !== predicate.value;
    if (predicate.op === "isNull") return row.value[predicate.field] == null;
    if (predicate.op === "eq") return row.value[predicate.field] === predicate.value;
    if (predicate.op !== "lt") return false;
    const current = row.value[predicate.field];
    return current instanceof Date &&
      predicate.value instanceof Date &&
      current.getTime() < predicate.value.getTime();
  }

  const updateMock = vi.fn(() => ({
    set: (values: Record<string, unknown>) => ({
      where: (predicate: Predicate) => {
        const execute = async () => {
          if (!matches(predicate)) return [];
          Object.assign(row.value, values);
          return [{ ...row.value }];
        };
        return {
          returning: async (selection: Record<string, string>) => {
            const rows = await execute();
            if (rows.length === 0) return [];
            return [
              Object.fromEntries(
                Object.entries(selection).map(([alias, field]) => [
                  alias,
                  row.value[field],
                ]),
              ),
            ];
          },
          then: (
            resolve: (value: unknown) => unknown,
            reject: (reason: unknown) => unknown,
          ) => execute().then(resolve, reject),
        };
      },
    }),
  }));
  return { row, gamesTable, updateMock };
});

vi.mock("@workspace/db", () => ({
  db: { update: updateMock },
  gamesTable,
}));

vi.mock("drizzle-orm", () => ({
  eq: (field: string, value: unknown): Predicate => ({ op: "eq", field, value }),
  lt: (field: string, value: unknown): Predicate => ({ op: "lt", field, value }),
  and: (...children: Predicate[]): Predicate => ({ op: "and", children }),
  or: (...children: Predicate[]): Predicate => ({ op: "or", children }),
  isNull: (field: string): Predicate => ({ op: "isNull", field }),
  sql: (strings: TemplateStringsArray, field: string): Predicate =>
    strings.join("").includes("IS NULL")
      ? { op: "isNull", field }
      : { op: "distinct", field, value: "processing" },
}));

import {
  claimReelLease,
  invalidateOutdatedReadyReel,
  invalidateReelLease,
  REEL_LEASE_MS,
  updateReelIfOwner,
} from "../reelLease";

beforeEach(() => {
  vi.clearAllMocks();
  row.value = {
    id: 42,
    highlightStatus: null,
    highlightRunToken: null,
    highlightLeaseExpiresAt: null,
    lowlightStatus: null,
    lowlightRunToken: null,
    lowlightLeaseExpiresAt: null,
  };
});

describe("database-owned reel leases", () => {
  it.each(["highlight", "lowlight"] as const)(
    "allows only one autoscaled instance to claim a %s run",
    async (kind) => {
      const now = new Date("2026-09-07T12:00:00Z");
      const [first, second] = await Promise.all([
        claimReelLease(42, kind, {}, now),
        claimReelLease(42, kind, {}, now),
      ]);

      expect([first, second].filter(Boolean)).toHaveLength(1);
      expect(row.value[`${kind}Status`]).toBe("processing");
      expect(row.value[`${kind}LeaseExpiresAt`]).toEqual(
        new Date(now.getTime() + REEL_LEASE_MS),
      );
    },
  );

  it.each(["highlight", "lowlight"] as const)(
    "does not let stale-version %s cleanup clobber a newly claimed run",
    async (kind) => {
      row.value[`${kind}Status`] = "ready";
      row.value[`${kind}GeneratorVersion`] = 1;

      // The GET request read the old ready row, but a POST wins the claim
      // before GET attempts its stale-version cleanup.
      const lease = await claimReelLease(
        42,
        kind,
        {},
        new Date("2026-09-07T12:00:00Z"),
      );
      expect(lease).not.toBeNull();

      const invalidated = await invalidateOutdatedReadyReel(42, kind, 10);
      expect(invalidated).toBe(false);
      expect(row.value[`${kind}Status`]).toBe("processing");
      expect(row.value[`${kind}RunToken`]).toBe(lease!.token);
    },
  );

  it.each(["highlight", "lowlight"] as const)(
    "fences a timed-out %s worker before a retry starts",
    async (kind) => {
      const first = await claimReelLease(
        42,
        kind,
        {},
        new Date("2026-09-07T12:00:00Z"),
      );
      expect(first).not.toBeNull();

      const timedOut = await updateReelIfOwner(42, kind, first!.token, {
        [`${kind}Status`]: "failed",
        [`${kind}RunToken`]: null,
        [`${kind}LeaseExpiresAt`]: null,
      });
      expect(timedOut).toBe(true);

      const retry = await claimReelLease(
        42,
        kind,
        {},
        new Date("2026-09-07T12:01:00Z"),
      );
      expect(retry).not.toBeNull();

      const stalePublish = await updateReelIfOwner(42, kind, first!.token, {
        [`${kind}Status`]: "ready",
        [`${kind}ObjectPath`]: "/timed-out-run.mp4",
      });
      expect(stalePublish).toBe(false);
      expect(row.value[`${kind}RunToken`]).toBe(retry!.token);
    },
  );

  it.each(["highlight", "lowlight"] as const)(
    "lets a restarted instance take an expired %s lease but fences the old run",
    async (kind) => {
      const first = await claimReelLease(
        42,
        kind,
        {},
        new Date("2026-09-07T12:00:00Z"),
      );
      expect(first).not.toBeNull();

      const replacement = await claimReelLease(
        42,
        kind,
        {},
        new Date("2026-09-07T12:11:00Z"),
      );
      expect(replacement).not.toBeNull();
      expect(replacement!.token).not.toBe(first!.token);

      const oldPublished = await updateReelIfOwner(42, kind, first!.token, {
        [`${kind}Status`]: "ready",
        [`${kind}ObjectPath`]: "/old-run.mp4",
      });
      const newPublished = await updateReelIfOwner(42, kind, replacement!.token, {
        [`${kind}Status`]: "ready",
        [`${kind}ObjectPath`]: "/new-run.mp4",
      });

      expect(oldPublished).toBe(false);
      expect(newPublished).toBe(true);
      expect(row.value[`${kind}ObjectPath`]).toBe("/new-run.mp4");
    },
  );

  it.each(["highlight", "lowlight"] as const)(
    "invalidates a cancelled %s lease so its worker cannot publish later",
    async (kind) => {
      const lease = await claimReelLease(
        42,
        kind,
        {},
        new Date("2026-09-07T12:00:00Z"),
      );
      expect(lease).not.toBeNull();

      await invalidateReelLease(42, kind, { [`${kind}Status`]: "failed" });
      const published = await updateReelIfOwner(42, kind, lease!.token, {
        [`${kind}Status`]: "ready",
        [`${kind}ObjectPath`]: "/cancelled-run.mp4",
      });

      expect(published).toBe(false);
      expect(row.value[`${kind}RunToken`]).toBeNull();
      expect(row.value[`${kind}ObjectPath`]).toBeUndefined();
    },
  );
});