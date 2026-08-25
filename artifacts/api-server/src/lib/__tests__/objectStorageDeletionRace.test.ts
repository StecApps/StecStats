import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  dbUpdateMock,
  findOwnerMock,
  bucketMock,
  fileMock,
  setAclMock,
} = vi.hoisted(() => {
  const fileMock = {
    save: vi.fn(),
    delete: vi.fn(),
    createWriteStream: vi.fn(),
    exists: vi.fn(),
    bucket: { name: "bucket" },
    name: "private/uploads/41/object",
  };
  return {
    dbUpdateMock: vi.fn(),
    findOwnerMock: vi.fn(),
    bucketMock: vi.fn(() => ({ file: vi.fn(() => fileMock) })),
    fileMock,
    setAclMock: vi.fn(),
  };
});

vi.mock("@workspace/db", () => ({
  db: {
    update: dbUpdateMock,
    query: { usersTable: { findFirst: findOwnerMock } },
  },
  usersTable: { id: "id", deletionStatus: "deletion_status" },
}));

vi.mock("@google-cloud/storage", () => ({
  Storage: class {
    bucket = bucketMock;
  },
}));

vi.mock("../objectAcl", () => ({
  setObjectAclPolicy: setAclMock,
  getObjectAclPolicy: vi.fn(),
  canAccessObject: vi.fn(),
}));

import { ObjectStorageService } from "../objectStorage";

describe("direct upload capability during account deletion", () => {
  const originalPrivateDir = process.env.PRIVATE_OBJECT_DIR;

  beforeEach(() => {
    process.env.PRIVATE_OBJECT_DIR = "/bucket/private";
    dbUpdateMock.mockReset();
    findOwnerMock.mockReset().mockResolvedValue({ deletionStatus: "active" });
    bucketMock.mockClear();
    fileMock.save.mockReset().mockResolvedValue(undefined);
    fileMock.delete.mockReset().mockResolvedValue(undefined);
    setAclMock.mockReset().mockResolvedValue(undefined);
    dbUpdateMock.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 41 }]),
        }),
      }),
    });
  });

  afterEach(() => {
    process.env.PRIVATE_OBJECT_DIR = originalPrivateDir;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("uses the reservation's exact expiry in the signed upload URL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-25T12:00:00.000Z"));
    const signedRequests: Array<{ expires_at: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      signedRequests.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ signed_url: "https://signed.example/upload" }));
    }));

    await expect(new ObjectStorageService().getObjectEntityUploadURL(41)).resolves.toBe(
      "https://signed.example/upload",
    );

    const pendingExpiry = dbUpdateMock.mock.results[0].value
      .set.mock.calls[0][0].pendingUploadExpiresAt as Date;
    expect(signedRequests[0].expires_at).toBe(pendingExpiry.toISOString());
  });

  it("removes the placeholder and returns no URL when deletion begins during issuance", async () => {
    fileMock.save.mockImplementation(async () => {
      findOwnerMock.mockResolvedValueOnce({ deletionStatus: "deleting" });
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(new ObjectStorageService().getObjectEntityUploadURL(41)).rejects.toThrow(
      "Account deletion is in progress",
    );

    expect(fileMock.delete).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});