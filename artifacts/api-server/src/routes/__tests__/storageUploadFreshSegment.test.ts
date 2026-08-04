/**
 * Storage fresh-segment ACL — cross-tenant access regression test
 *
 * Verifies that a foreign coach (Coach B) cannot access a freshly uploaded
 * segment before a game row is saved — the exact attack window Task #114
 * was designed to close.
 *
 * Timeline under test:
 *   1. Coach A calls POST /api/storage/uploads/request-url → receives objectPath
 *      (path-namespaced as /objects/uploads/{coachA.id}/{uuid})
 *   2. No game row exists (client has not yet saved the game).
 *   3. ACL metadata has been cleared by the GCS signed PUT (simulated by
 *      canAccessObjectEntity returning false).
 *   4. Coach B calls GET /api/storage/objects/<objectPath> → must get 404.
 *   5. Coach A calls the same endpoint → must get 200 / 302 (path-based auth).
 *
 * Defence mechanism tested: the `isOwnedByPath()` path-based ownership check
 * in storage.ts, which verifies that /objects/uploads/{ownerId}/… encodes
 * the requesting user's ownerId — providing ownership proof without relying
 * on DB rows or GCS ACL metadata.
 *
 * All I/O (GCS, DB) is replaced with in-memory mocks so no real credentials
 * are required.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// Fixtures — hoisted so vi.mock() factories can close over them.
// ---------------------------------------------------------------------------
const { COACH_A, COACH_B, currentUser } = vi.hoisted(() => {
  const COACH_A = { id: 7, clerkUserId: "clerk_coach_a_fresh", email: "coach-a-fresh@example.com" };
  const COACH_B = { id: 8, clerkUserId: "clerk_coach_b_fresh", email: "coach-b-fresh@example.com" };
  const currentUser = { value: COACH_A as typeof COACH_A };
  return { COACH_A, COACH_B, currentUser };
});

// ---------------------------------------------------------------------------
// Module mocks — declared before any import that triggers them.
// ---------------------------------------------------------------------------

// Database: no game rows exist (the window before save).
vi.mock("@workspace/db", () => ({
  db: {
    query: {
      gamesTable: {
        // Always returns undefined — game row has not been saved yet.
        findFirst: vi.fn().mockResolvedValue(undefined),
      },
      playersTable: {
        findFirst: vi.fn().mockResolvedValue(undefined),
      },
    },
  },
  gamesTable: {
    ownerId: "owner_id",
    videoObjectPath: "video_object_path",
    highlightObjectPath: "highlight_object_path",
  },
  playersTable: {
    ownerId: "owner_id",
    photoObjectPath: "photo_object_path",
  },
}));

vi.mock("../../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock("../../middlewares/requireAuth", () => ({
  requireAuth: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    req.appUser = { ...currentUser.value } as any;
    next();
  },
}));

// Object storage mock:
//  - getObjectEntityUploadURL: returns a GCS-style URL whose path encodes the
//    owner's id, matching what the real implementation produces.
//  - normalizeObjectEntityPath: converts the GCS URL to /objects/… path, also
//    matching the real implementation.
//  - getObjectEntityFile: always resolves (the blob physically exists in GCS).
//  - canAccessObjectEntity: returns false (ACL metadata cleared by signed PUT).
//  - getObjectEntitySignedURL: returns a dummy URL for successful read proofs.
vi.mock("../../lib/objectStorage", () => {
  const { randomUUID } = require("crypto");

  const PRIVATE_DIR = "/bucket/private";

  // Minimal mock GCS File object with only the fields storage.ts uses.
  const makeMockFile = () => ({
    getMetadata: vi.fn().mockResolvedValue([
      { contentType: "video/mp4", size: 5_000_000 },
    ]),
    createReadStream: vi.fn().mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Readable } = require("stream");
      const s = new Readable({ read() {} });
      process.nextTick(() => s.push(null));
      return s;
    }),
  });

  class ObjectStorageService {
    getObjectEntityUploadURL = vi.fn().mockImplementation(async (ownerId: number) => {
      const uuid = randomUUID();
      // Mirrors the real implementation's path convention.
      return `https://storage.googleapis.com${PRIVATE_DIR}/uploads/${ownerId}/${uuid}`;
    });

    normalizeObjectEntityPath = vi.fn().mockImplementation((rawPath: string) => {
      // Mirrors the real implementation: strip GCS host + PRIVATE_DIR prefix
      // and prepend /objects/.
      if (!rawPath.startsWith("https://storage.googleapis.com")) return rawPath;
      const url = new URL(rawPath);
      const pathname = url.pathname; // e.g. /bucket/private/uploads/7/uuid
      const prefix = `${PRIVATE_DIR}/`;
      if (!pathname.startsWith(prefix)) return pathname;
      const entityId = pathname.slice(prefix.length); // uploads/7/uuid
      return `/objects/${entityId}`;
    });

    getObjectEntityFile = vi.fn().mockResolvedValue(makeMockFile());

    canAccessObjectEntity = vi.fn().mockResolvedValue(false);

    getObjectEntitySignedURL = vi
      .fn()
      .mockResolvedValue("https://storage.googleapis.com/signed-url-stub");
  }

  class ObjectNotFoundError extends Error {
    constructor(msg = "Not found") {
      super(msg);
      this.name = "ObjectNotFoundError";
      Object.setPrototypeOf(this, new.target.prototype);
    }
  }

  return { ObjectStorageService, ObjectNotFoundError };
});

vi.mock("../../lib/objectAcl", () => ({
  ObjectPermission: { READ: "READ", WRITE: "WRITE" },
}));

// ---------------------------------------------------------------------------
// Real imports (after mocks are registered).
// ---------------------------------------------------------------------------
import storageRouter from "../storage";

// ---------------------------------------------------------------------------
// Express app shared across all tests.
// ---------------------------------------------------------------------------
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());

  // Inject a silent req.log stub so route logging doesn't throw.
  app.use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as any).log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    next();
  });

  app.use("/api", storageRouter);

  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.restoreAllMocks();
});

// Reset to Coach A before every test.
beforeEach(() => {
  currentUser.value = COACH_A;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function requestUploadUrl() {
  return fetch(`${baseUrl}/api/storage/uploads/request-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "game.mp4", size: 50_000_000, contentType: "video/mp4" }),
  });
}

function objectEndpoint(objectPath: string): string {
  // objectPath is /objects/uploads/7/uuid — strip the leading /objects/
  const segment = objectPath.replace(/^\/objects\//, "");
  return `${baseUrl}/api/storage/objects/${segment}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Storage fresh-segment ACL — path-based ownership during upload window", () => {
  it("POST /api/storage/uploads/request-url returns an objectPath namespaced to Coach A", async () => {
    currentUser.value = COACH_A;

    const res = await requestUploadUrl();
    expect(res.status).toBe(200);

    const body = (await res.json()) as { objectPath: string; uploadURL: string };
    expect(typeof body.objectPath).toBe("string");
    // Path must be namespaced under Coach A's ownerId.
    expect(body.objectPath).toMatch(new RegExp(`^/objects/uploads/${COACH_A.id}/`));
  });

  it("Coach B gets 404 for the freshly requested path (no game row, ACL cleared)", async () => {
    // Step 1: Coach A obtains an objectPath.
    currentUser.value = COACH_A;
    const uploadRes = await requestUploadUrl();
    expect(uploadRes.status).toBe(200);
    const { objectPath } = (await uploadRes.json()) as { objectPath: string };

    // Step 2: No game row saved, ACL metadata cleared — only path-based check remains.
    // Step 3: Coach B tries to read Coach A's segment.
    currentUser.value = COACH_B;
    const readRes = await fetch(objectEndpoint(objectPath));
    expect(readRes.status).toBe(404);

    const body = (await readRes.json()) as { error: string };
    expect(body.error).toBeTruthy();
    // Confirm the object path itself does not leak into the error body.
    expect(JSON.stringify(body)).not.toContain(objectPath);
  });

  it("Coach A gets 200/302 for the same path (path-based ownership passes)", async () => {
    // Step 1: Coach A obtains an objectPath.
    currentUser.value = COACH_A;
    const uploadRes = await requestUploadUrl();
    expect(uploadRes.status).toBe(200);
    const { objectPath } = (await uploadRes.json()) as { objectPath: string };

    // Step 2: Coach A reads back the same path — must succeed via path-based check.
    // video/mp4 triggers a 302 redirect to a signed GCS URL; follow:manual so
    // we can inspect the redirect without needing a real GCS endpoint.
    const readRes = await fetch(objectEndpoint(objectPath), { redirect: "manual" });
    // video/mp4 content type → the route issues a 302 redirect to a signed URL.
    expect(readRes.status).toBe(302);
  });

  it("Coach B cannot access a path prefixed with Coach A's id even with a guessed uuid", async () => {
    // Simulate a path-guessing attack: Coach B constructs a path that looks
    // like Coach A's upload namespace with a guessed UUID.
    const guessedUuid = randomUUID();
    const guessedPath = `/objects/uploads/${COACH_A.id}/${guessedUuid}`;

    currentUser.value = COACH_B;
    const readRes = await fetch(objectEndpoint(guessedPath));
    expect(readRes.status).toBe(404);

    const body = (await readRes.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });

  it("Coach A cannot access a path prefixed with Coach B's id (ownership is directional)", async () => {
    // Even if Coach A somehow knows a path in Coach B's namespace, they must
    // not be able to access it through path-based ownership alone.
    const uuid = randomUUID();
    const coachBPath = `/objects/uploads/${COACH_B.id}/${uuid}`;

    currentUser.value = COACH_A;
    const readRes = await fetch(objectEndpoint(coachBPath));
    expect(readRes.status).toBe(404);

    const body = (await readRes.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });
});
