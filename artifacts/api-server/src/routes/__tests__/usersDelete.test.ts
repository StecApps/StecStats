import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";

const {
  currentUser,
  findGamesMock,
  findPlayersMock,
  findTeamsMock,
  findUserMock,
  deleteObjectEntityMock,
  deleteOwnerUploadNamespaceMock,
  transactionMock,
  transactionDeleteMock,
  transactionUpdateMock,
  updateMock,
  updateSetMock,
  updateWhereMock,
  deleteClerkUserMock,
  cancelOwnerMediaDeletionMock,
  resumeOwnerMediaWritesMock,
  revokeTokenMock,
  decryptTokenMock,
} = vi.hoisted(() => {
  const currentUser = {
    value: { id: 41, clerkUserId: "clerk-delete-test", email: "delete@example.com" },
  };
  const findGamesMock = vi.fn();
  const findPlayersMock = vi.fn();
  const findTeamsMock = vi.fn();
  const findUserMock = vi.fn();
  const deleteObjectEntityMock = vi.fn();
  const deleteOwnerUploadNamespaceMock = vi.fn();
  const transactionDeleteMock = vi.fn();
  const transactionUpdateMock = vi.fn();
  const transactionMock = vi.fn();
  const updateWhereMock = vi.fn();
  const updateSetMock = vi.fn();
  const updateMock = vi.fn();
  const deleteClerkUserMock = vi.fn();
  const cancelOwnerMediaDeletionMock = vi.fn();
  const resumeOwnerMediaWritesMock = vi.fn();
  const revokeTokenMock = vi.fn();
  const decryptTokenMock = vi.fn((token: string) => token);
  return {
    currentUser,
    findGamesMock,
    findPlayersMock,
    findTeamsMock,
    findUserMock,
    deleteObjectEntityMock,
    deleteOwnerUploadNamespaceMock,
    transactionMock,
    transactionDeleteMock,
    transactionUpdateMock,
    deleteClerkUserMock,
    updateMock,
    updateSetMock,
    updateWhereMock,
    cancelOwnerMediaDeletionMock,
    resumeOwnerMediaWritesMock,
    revokeTokenMock,
    decryptTokenMock,
  };
});

vi.mock("../../middlewares/requireAuth", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.appUser = { ...currentUser.value } as any;
    req.authenticatedClerkUserId = currentUser.value.clerkUserId;
    next();
  },
}));

vi.mock("@clerk/express", () => ({
  clerkClient: { users: { deleteUser: deleteClerkUserMock, updateUser: vi.fn() } },
}));

vi.mock("../../lib/objectStorage", () => ({
  ObjectStorageService: class {
    deleteObjectEntity = deleteObjectEntityMock;
    deleteObjectEntityPrefix = deleteOwnerUploadNamespaceMock;
  },
}));

vi.mock("../../lib/highlightGenerator", () => ({
  cancelOwnerMediaDeletion: cancelOwnerMediaDeletionMock,
  resumeOwnerMediaWrites: resumeOwnerMediaWritesMock,
}));

vi.mock("../../lib/youtubeClient", () => ({
  revokeToken: revokeTokenMock,
}));

vi.mock("../../lib/tokenEncryption", () => ({
  decryptToken: decryptTokenMock,
}));

vi.mock("@workspace/db", () => ({
  db: {
    query: {
      gamesTable: { findMany: findGamesMock, findFirst: vi.fn() },
      playersTable: { findMany: findPlayersMock, findFirst: vi.fn() },
      teamsTable: { findMany: findTeamsMock, findFirst: vi.fn() },
      usersTable: { findFirst: findUserMock },
    },
    transaction: transactionMock,
    update: updateMock,
  },
  usersTable: { id: "id", deletionStatus: "deletion_status" },
  gamesTable: { ownerId: "owner_id" },
  playersTable: { ownerId: "owner_id" },
  teamsTable: { ownerId: "owner_id" },
  feedbackTable: { userId: "user_id" },
  purchaseEventsTable: { userId: "user_id" },
}));

import usersRouter from "../users";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", usersRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  currentUser.value = { id: 41, clerkUserId: "clerk-delete-test", email: "delete@example.com" };
  findGamesMock.mockResolvedValue([
    {
      id: 77,
      videoObjectPath: "/objects/uploads/41/source.mp4",
      highlightObjectPath: "/objects/uploads/41/highlight.mp4",
      lowlightObjectPath: null,
      videoProxyObjectPath: "/objects/uploads/41/proxy.mp4",
    },
  ]);
  findPlayersMock.mockResolvedValue([{ photoObjectPath: "/objects/uploads/41/player.jpg" }]);
  findTeamsMock.mockResolvedValue([{ highlightObjectPath: "/objects/uploads/41/season.mp4" }]);
  findUserMock.mockResolvedValue({ youtubeRefreshToken: "encrypted-youtube-token" });
  deleteObjectEntityMock.mockReset().mockResolvedValue(undefined);
  deleteOwnerUploadNamespaceMock.mockReset().mockResolvedValue(undefined);
  deleteClerkUserMock.mockReset().mockResolvedValue(undefined);
  cancelOwnerMediaDeletionMock.mockReset();
  resumeOwnerMediaWritesMock.mockReset();
  revokeTokenMock.mockReset().mockResolvedValue(undefined);
  decryptTokenMock.mockClear();
  transactionDeleteMock.mockReset().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
  transactionUpdateMock.mockReset().mockReturnValue({
    set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
  });
  transactionMock.mockReset().mockImplementation(async (callback) =>
    callback({ delete: transactionDeleteMock, update: transactionUpdateMock }),
  );
  updateWhereMock.mockReset().mockResolvedValue(undefined);
  updateSetMock.mockReset().mockReturnValue({ where: updateWhereMock });
  updateMock.mockReset().mockReturnValue({ set: updateSetMock });
});

describe("DELETE /users/me", () => {
  it("removes linked media, account data, and the Clerk identity", async () => {
    const response = await fetch(`${baseUrl}/api/users/me`, { method: "DELETE" });

    expect(response.status).toBe(204);
    expect(deleteOwnerUploadNamespaceMock).toHaveBeenCalledWith("/objects/uploads/41/");
    expect(cancelOwnerMediaDeletionMock).toHaveBeenCalledWith(41, [77]);
    expect(revokeTokenMock).toHaveBeenCalledWith("encrypted-youtube-token");
    expect(transactionDeleteMock).toHaveBeenCalledTimes(5);
    expect(transactionUpdateMock).toHaveBeenCalledTimes(1);
    expect(deleteClerkUserMock).toHaveBeenCalledWith("clerk-delete-test");
  });

  it("quarantines the account when a media sweep partially fails", async () => {
    deleteOwnerUploadNamespaceMock.mockRejectedValueOnce(new Error("Storage unavailable"));

    const response = await fetch(`${baseUrl}/api/users/me`, { method: "DELETE" });

    expect(response.status).toBe(503);
    expect(transactionMock).not.toHaveBeenCalled();
    expect(deleteClerkUserMock).not.toHaveBeenCalled();
    expect(revokeTokenMock).not.toHaveBeenCalled();
    expect(resumeOwnerMediaWritesMock).not.toHaveBeenCalled();
  });

  it("leaves a retryable sign-in identity when Clerk deletion fails after local cleanup", async () => {
    deleteClerkUserMock.mockRejectedValueOnce(new Error("Clerk unavailable"));

    const response = await fetch(`${baseUrl}/api/users/me`, { method: "DELETE" });

    expect(response.status).toBe(503);
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(resumeOwnerMediaWritesMock).not.toHaveBeenCalled();
  });

  it("keeps the write barrier when local database cleanup fails", async () => {
    transactionMock.mockRejectedValueOnce(new Error("Database unavailable"));

    const response = await fetch(`${baseUrl}/api/users/me`, { method: "DELETE" });

    expect(response.status).toBe(503);
    expect(deleteClerkUserMock).not.toHaveBeenCalled();
    expect(resumeOwnerMediaWritesMock).not.toHaveBeenCalled();
  });
});