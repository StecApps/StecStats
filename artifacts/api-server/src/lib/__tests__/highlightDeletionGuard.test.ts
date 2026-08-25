import { beforeEach, describe, expect, it, vi } from "vitest";

const { findOwnerMock, uploadMock, writeFileMock, unlinkMock } = vi.hoisted(() => ({
  findOwnerMock: vi.fn(),
  uploadMock: vi.fn(),
  writeFileMock: vi.fn(),
  unlinkMock: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  db: {
    query: { usersTable: { findFirst: findOwnerMock } },
  },
  usersTable: { id: "id" },
  gamesTable: {},
  gameEventsTable: {},
  playersTable: {},
  teamsTable: {},
}));

vi.mock("../objectStorage", () => ({
  ObjectStorageService: class {
    uploadLocalFileToObjectPath = uploadMock;
  },
}));

vi.mock("fs", () => ({
  promises: {
    writeFile: writeFileMock,
    unlink: unlinkMock,
  },
  createWriteStream: vi.fn(),
}));

import { writeHlsSentinel } from "../highlightGenerator";

describe("HLS completion during account deletion", () => {
  beforeEach(() => {
    findOwnerMock.mockReset();
    uploadMock.mockReset();
    writeFileMock.mockReset().mockResolvedValue(undefined);
    unlinkMock.mockReset().mockResolvedValue(undefined);
  });

  it("does not recreate the completion sentinel after the owner is quarantined", async () => {
    // This models a worker that has already encoded every chunk when account
    // deletion sweeps the uploads namespace and marks the owner as deleting.
    findOwnerMock.mockResolvedValue({ deletionStatus: "deleting" });

    await expect(writeHlsSentinel(41, 77, 2, [10, 9.5])).rejects.toThrow(
      "Account deletion is in progress",
    );

    expect(uploadMock).not.toHaveBeenCalled();
    // The pre-write guard rejects before a temporary sentinel is created.
    expect(unlinkMock).not.toHaveBeenCalled();
  });
});