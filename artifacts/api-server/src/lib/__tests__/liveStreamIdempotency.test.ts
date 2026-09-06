import { beforeEach, describe, expect, it, vi } from "vitest";

const { rows } = vi.hoisted(() => ({
  rows: new Map<string, any>(),
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn(),
  eq: vi.fn(),
  lt: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  liveSessionsTable: {
    code: "code",
    active: "active",
    lastSeenAt: "lastSeenAt",
  },
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation((value: any) => ({
        onConflictDoNothing: vi.fn().mockReturnValue({
          returning: vi.fn().mockImplementation(async () => {
            if (rows.has(value.code)) return [];
            rows.set(value.code, {
              ...value,
              teamScore: 0,
              opponentScore: 0,
              createdAt: new Date(),
              lastSeenAt: new Date(),
            });
            return [{ code: value.code }];
          }),
        }),
      })),
    }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockImplementation(async () => [...rows.values()].slice(0, 1)),
        }),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  },
}));

vi.mock("../logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { LiveStreamRegistry } from "../liveStream";

describe("LiveStreamRegistry preferred invite codes", () => {
  beforeEach(() => {
    rows.clear();
  });

  it("resumes the persisted winner when two instances create the same preferred code", async () => {
    const firstRegistry = new LiveStreamRegistry();
    const secondRegistry = new LiveStreamRegistry();
    const meta = { opponent: "Rivals", teamName: "Home" };

    const [first, second] = await Promise.all([
      firstRegistry.createSession(meta, "A1B2C3D4E5F60708"),
      secondRegistry.createSession(meta, "A1B2C3D4E5F60708"),
    ]);

    expect(first.code).toBe("A1B2C3D4E5F60708");
    expect(second.code).toBe(first.code);
    expect(rows).toHaveLength(1);
  });
});