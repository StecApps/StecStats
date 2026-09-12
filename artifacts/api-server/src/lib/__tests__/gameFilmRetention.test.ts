import { beforeEach, describe, expect, it, vi } from "vitest";

const { insertMock, valuesMock, onConflictDoNothingMock } = vi.hoisted(() => ({
  insertMock: vi.fn(),
  valuesMock: vi.fn(),
  onConflictDoNothingMock: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  db: { insert: insertMock },
  retainedGameFilmsTable: { objectPath: "object_path" },
}));

import { retainGameMasterFilm } from "../gameFilmRetention";

describe("merge master-film retention ledger", () => {
  beforeEach(() => {
    insertMock.mockReset();
    valuesMock.mockReset();
    onConflictDoNothingMock.mockReset();
  });

  it("records every concat source and the new merged master idempotently before replacement", async () => {
    onConflictDoNothingMock.mockResolvedValue(undefined);
    valuesMock.mockReturnValue({ onConflictDoNothing: onConflictDoNothingMock });
    insertMock.mockReturnValue({ values: valuesMock });
    const tx = { insert: insertMock } as any;

    await retainGameMasterFilm(tx, 7, 101, "/objects/uploads/7/primary.mp4");
    await retainGameMasterFilm(tx, 7, 102, "/objects/uploads/7/donor.mp4");
    await retainGameMasterFilm(tx, 7, 101, "/objects/uploads/7/merged.mp4");

    expect(valuesMock).toHaveBeenNthCalledWith(1, {
      ownerId: 7, originalGameId: 101, objectPath: "/objects/uploads/7/primary.mp4",
    });
    expect(valuesMock).toHaveBeenNthCalledWith(2, {
      ownerId: 7, originalGameId: 102, objectPath: "/objects/uploads/7/donor.mp4",
    });
    expect(valuesMock).toHaveBeenNthCalledWith(3, {
      ownerId: 7, originalGameId: 101, objectPath: "/objects/uploads/7/merged.mp4",
    });
    expect(onConflictDoNothingMock).toHaveBeenCalledTimes(3);
  });

  it("records both outgoing primary and adopted single-donor masters idempotently", async () => {
    onConflictDoNothingMock.mockResolvedValue(undefined);
    valuesMock.mockReturnValue({ onConflictDoNothing: onConflictDoNothingMock });
    insertMock.mockReturnValue({ values: valuesMock });
    const tx = { insert: insertMock } as any;

    await retainGameMasterFilm(tx, 7, 101, "/objects/uploads/7/primary-old.mp4");
    await retainGameMasterFilm(tx, 7, 102, "/objects/uploads/7/donor-only.mp4");

    expect(valuesMock).toHaveBeenNthCalledWith(1, {
      ownerId: 7, originalGameId: 101, objectPath: "/objects/uploads/7/primary-old.mp4",
    });
    expect(valuesMock).toHaveBeenNthCalledWith(2, {
      ownerId: 7, originalGameId: 102, objectPath: "/objects/uploads/7/donor-only.mp4",
    });
    expect(onConflictDoNothingMock).toHaveBeenCalledTimes(2);
  });
});