/**
 * GET/PATCH/DELETE /api/users/me — profile and account-deletion route tests
 *
 * Confirms the PATCH /api/users/me flow works end-to-end after the
 * first_name / last_name columns were added to the users table:
 *   1. PATCH saves the name into the in-memory users row.
 *   2. A subsequent GET returns the saved name (persistence simulation).
 *   3. Invalid input (missing firstName) is rejected with HTTP 400.
 *   4. GET returns null fields when no name has been saved yet (Clerk fallback).
 *   5. lastName can be cleared by passing an empty string.
 *
 * No real database is required — the db mock uses an in-memory users store.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------
const { currentUser, authenticatedClerkUserId, store } = vi.hoisted(() => {
  const COACH = { id: 1, clerkUserId: "clerk_coach_a", email: "coach@example.com" };
  const currentUser = { value: COACH as typeof COACH };
  const authenticatedClerkUserId = { value: COACH.clerkUserId };

  const store = {
    users: [
      {
        id: 1,
        clerkUserId: "clerk_coach_a",
        email: "coach@example.com",
        firstName: null as string | null,
        lastName: null as string | null,
        stripeCustomerId: null,
        youtubeRefreshToken: null,
        revenueCatEntitlement: null,
        deletionStatus: "active",
        deletionStartedAt: null,
        pendingUploadExpiresAt: null,
        createdAt: new Date("2024-01-01"),
      },
    ] as any[],
    resetUsers() {
      this.users[0].firstName = null;
      this.users[0].lastName = null;
      this.users[0].deletionStatus = "active";
      this.users[0].deletionStartedAt = null;
      this.users[0].pendingUploadExpiresAt = null;
    },
  };

  return { currentUser, authenticatedClerkUserId, store };
});

const { mockDeleteClerkUser, mockDeleteObjectPrefix } = vi.hoisted(() => ({
  mockDeleteClerkUser: vi.fn(),
  mockDeleteObjectPrefix: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("../../middlewares/requireAuth", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.appUser = { ...store.users[0] } as any;
    req.authenticatedClerkUserId = authenticatedClerkUserId.value;
    next();
  },
}));

vi.mock("../../lib/logger", () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock("@clerk/express", () => ({
  clerkClient: {
    users: {
      updateUser: vi.fn(),
      deleteUser: mockDeleteClerkUser,
    },
  },
}));

vi.mock("../../lib/objectStorage", () => ({
  ObjectStorageService: class {
    deleteObjectEntity = vi.fn();
    deleteObjectEntityPrefix = mockDeleteObjectPrefix;
  },
}));

vi.mock("@workspace/db", () => {
  const USERS_T = "usersTable";
  const TEAMS_T = "teamsTable";
  const PLAYERS_T = "playersTable";
  const GAMES_T = "gamesTable";
  const FEEDBACK_T = "feedbackTable";
  const PURCHASE_EVENTS_T = "purchaseEventsTable";
  const whereResult = vi.fn().mockResolvedValue(undefined);
  const tx = {
    delete: vi.fn(() => ({ where: whereResult })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: whereResult })),
    })),
  };

  const db = {
    query: {
      usersTable: {
        findFirst: vi.fn().mockImplementation(async () =>
          store.users[0],
        ),
      },
      gamesTable: { findMany: vi.fn().mockResolvedValue([]) },
      playersTable: { findMany: vi.fn().mockResolvedValue([]) },
      teamsTable: { findMany: vi.fn().mockResolvedValue([]) },
    },
    update: vi.fn().mockImplementation((_table: string) => ({
      set: vi.fn().mockImplementation((vals: any) => ({
        where: vi.fn().mockImplementation(() => {
          // Apply changes to the in-memory user row.
          Object.assign(store.users[0], vals);
          return {
            returning: vi.fn().mockResolvedValue([{ ...store.users[0] }]),
          };
        }),
      })),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([]),
      })),
    })),
    delete: vi.fn(() => ({ where: whereResult })),
    transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<void>) =>
      callback(tx),
    ),
  };

  return {
    db,
    usersTable: USERS_T,
    teamsTable: TEAMS_T,
    playersTable: PLAYERS_T,
    gamesTable: GAMES_T,
    feedbackTable: FEEDBACK_T,
    purchaseEventsTable: PURCHASE_EVENTS_T,
  };
});

// ---------------------------------------------------------------------------
// Real import (after mocks)
// ---------------------------------------------------------------------------
import usersRouter from "../users";

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
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
  vi.restoreAllMocks();
});

beforeEach(() => {
  store.resetUsers();
  authenticatedClerkUserId.value = currentUser.value.clerkUserId;
  mockDeleteClerkUser.mockReset();
  mockDeleteObjectPrefix.mockReset();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getMe() {
  return fetch(`${baseUrl}/api/users/me`);
}

async function patchMe(body: object) {
  return fetch(`${baseUrl}/api/users/me`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function deleteMe() {
  return fetch(`${baseUrl}/api/users/me`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/users/me — initial state", () => {
  it("returns null firstName and lastName when no name is stored yet", async () => {
    const res = await getMe();
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.firstName).toBeNull();
    expect(body.lastName).toBeNull();
  });
});

describe("PATCH /api/users/me — save name", () => {
  it("saves firstName and lastName and returns them in the response", async () => {
    const res = await patchMe({ firstName: "Jordan", lastName: "Smith" });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.firstName).toBe("Jordan");
    expect(body.lastName).toBe("Smith");
  });

  it("persists the saved name so GET /api/users/me returns it afterwards", async () => {
    const patchRes = await patchMe({ firstName: "Jordan", lastName: "Smith" });
    expect(patchRes.status).toBe(200);

    const getRes = await getMe();
    expect(getRes.status).toBe(200);
    const body = await getRes.json() as any;
    expect(body.firstName).toBe("Jordan");
    expect(body.lastName).toBe("Smith");
  });

  it("trims leading/trailing whitespace from the saved name", async () => {
    const res = await patchMe({ firstName: "  Alex  ", lastName: "  Lee  " });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.firstName).toBe("Alex");
    expect(body.lastName).toBe("Lee");
  });

  it("saves a firstName-only name (no lastName)", async () => {
    const res = await patchMe({ firstName: "Coach" });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.firstName).toBe("Coach");
    // lastName was not sent, so the stored value is null (unchanged)
    expect(body.lastName).toBeNull();
  });

  it("clears lastName when an empty string is sent", async () => {
    // First set a name
    await patchMe({ firstName: "Sam", lastName: "Jones" });
    // Then clear the last name
    const res = await patchMe({ firstName: "Sam", lastName: "" });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.firstName).toBe("Sam");
    expect(body.lastName).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PUT /api/users/me/push-token — store the Expo push token
// ---------------------------------------------------------------------------

async function putPushToken(body: object) {
  return fetch(`${baseUrl}/api/users/me/push-token`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PUT /api/users/me/push-token — valid token", () => {
  it("returns 204 when a well-formed ExponentPushToken is supplied", async () => {
    const res = await putPushToken({ token: "ExponentPushToken[abc123XYZ]" });
    expect(res.status).toBe(204);
  });

  it("persists the token — the in-memory store receives the update", async () => {
    await putPushToken({ token: "ExponentPushToken[storeMe999]" });
    expect(store.users[0].pushToken).toBe("ExponentPushToken[storeMe999]");
  });

  it("accepts tokens with dashes and dots inside the brackets", async () => {
    const res = await putPushToken({ token: "ExponentPushToken[Abc-123.xyz_OK]" });
    expect(res.status).toBe(204);
  });
});

describe("PUT /api/users/me/push-token — invalid inputs", () => {
  it("rejects a plain string with HTTP 400", async () => {
    const res = await putPushToken({ token: "not-a-valid-token" });
    expect(res.status).toBe(400);
  });

  it("rejects an FCM-style token with HTTP 400", async () => {
    const res = await putPushToken({ token: "APA91bFcm-token-xyz" });
    expect(res.status).toBe(400);
  });

  it("rejects an empty string with HTTP 400", async () => {
    const res = await putPushToken({ token: "" });
    expect(res.status).toBe(400);
  });

  it("rejects a missing token field with HTTP 400", async () => {
    const res = await putPushToken({});
    expect(res.status).toBe(400);
  });

  it("rejects a numeric token with HTTP 400", async () => {
    const res = await putPushToken({ token: 12345 });
    expect(res.status).toBe(400);
  });

  it("does not overwrite a valid stored token after a failed update", async () => {
    store.users[0].pushToken = "ExponentPushToken[original]";
    await putPushToken({ token: "bad-token" });
    expect(store.users[0].pushToken).toBe("ExponentPushToken[original]");
  });
});

describe("PATCH /api/users/me — validation", () => {
  it("rejects an empty firstName with HTTP 400", async () => {
    const res = await patchMe({ firstName: "" });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toMatch(/firstName/i);
  });

  it("rejects a whitespace-only firstName with HTTP 400", async () => {
    const res = await patchMe({ firstName: "   " });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toMatch(/firstName/i);
  });

  it("does not update the stored name when validation fails", async () => {
    // Seed a valid name first
    await patchMe({ firstName: "Original", lastName: "Name" });

    // Attempt an invalid patch
    await patchMe({ firstName: "" });

    // Name must still be the original
    const getRes = await getMe();
    const body = await getRes.json() as any;
    expect(body.firstName).toBe("Original");
    expect(body.lastName).toBe("Name");
  });
});

describe("DELETE /api/users/me — account deletion", () => {
  it("removes local account data, its upload namespace, and the Clerk identity", async () => {
    const res = await deleteMe();

    expect(res.status).toBe(204);
    expect(mockDeleteObjectPrefix).toHaveBeenCalledWith("/objects/uploads/1/");
    expect(mockDeleteClerkUser).toHaveBeenCalledWith("clerk_coach_a");
  });

  it("uses the authenticated subject carried by requireAuth and rejects a secondary identity before deleting data", async () => {
    authenticatedClerkUserId.value = "clerk_secondary_identity";

    const res = await deleteMe();

    expect(res.status).toBe(409);
    expect(mockDeleteObjectPrefix).not.toHaveBeenCalled();
    expect(mockDeleteClerkUser).not.toHaveBeenCalled();
  });
});
