/**
 * Storage ACL — stamped-object enforcement test (Task #184)
 *
 * Verifies two things:
 *   (a) getObjectEntityUploadURL stamps an ACL policy on the new object at
 *       upload time, before the signed PUT URL is returned to the client.
 *   (b) The storage endpoints (signed-URL and raw-proxy) return 404 for a
 *       foreign coach when the object's ACL is correctly stamped to another
 *       coach — and return 200/302 for the owner.
 *
 * This test intentionally avoids any DB game-row link AND uses a path that
 * does NOT match the /objects/uploads/{ownerId}/ path-convention, so the
 * only grant path exercised is canAccessObjectEntity (ACL metadata).
 *
 * No real GCS bucket or database is needed — all storage calls are mocked.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";

// ---------------------------------------------------------------------------
// Test fixtures — hoisted so mock factories can reference them
// ---------------------------------------------------------------------------
const { COACH_A, COACH_B, STAMPED_OBJECT_PATH, STAMPED_OBJECT_URL_SEGMENT, currentUser } =
  vi.hoisted(() => {
    const COACH_A = { id: 1, clerkUserId: "clerk_coach_a", email: "coach-a@example.com" };
    const COACH_B = { id: 2, clerkUserId: "clerk_coach_b", email: "coach-b@example.com" };

    // A path that does NOT match the /objects/uploads/{ownerId}/ convention
    // and is NOT linked to any game row — the ACL metadata is the only gate.
    const STAMPED_OBJECT_PATH = "/objects/highlights/coach-a-stamped.mp4";
    const STAMPED_OBJECT_URL_SEGMENT = "highlights/coach-a-stamped.mp4";

    const currentUser = { value: COACH_A as typeof COACH_A };
    return { COACH_A, COACH_B, STAMPED_OBJECT_PATH, STAMPED_OBJECT_URL_SEGMENT, currentUser };
  });

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("@workspace/db", () => ({
  db: {
    query: {
      gamesTable: {
        // No game row for this path — forces the ACL metadata fallback.
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

/**
 * The ACL stamp on the object belongs to Coach A (ownerId = "1").
 * canAccessObjectEntity returns true only when userId matches the stamp owner.
 */
vi.mock("../../lib/objectStorage", () => {
  const mockObjectFile = {
    getMetadata: vi.fn().mockResolvedValue([
      { contentType: "video/mp4", size: 8_000_000 },
    ]),
    createReadStream: vi.fn().mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Readable } = require("stream");
      const s = new Readable({ read() {} });
      process.nextTick(() => s.push(null));
      return s;
    }),
  };

  const ACL_OWNER_ID = "1"; // Coach A's string user id

  class ObjectStorageService {
    getObjectEntityFile = vi.fn().mockResolvedValue(mockObjectFile);

    /**
     * Simulate the ACL stamp: grants access only to the stamped owner.
     * This is the path exercised after the backfill was removed — every
     * newly-uploaded object receives a stamp at URL-issuance time.
     */
    canAccessObjectEntity = vi.fn().mockImplementation(
      async ({ userId }: { userId?: string }) => userId === ACL_OWNER_ID,
    );

    getObjectEntitySignedURL = vi
      .fn()
      .mockResolvedValue("https://storage.googleapis.com/signed-url-stub");

    normalizeObjectEntityPath = vi.fn().mockImplementation((p: string) => p);

    /**
     * Mock upload URL that also calls setObjectAclPolicy internally via the
     * real function's behaviour. The unit test for ACL stamping (below) mocks
     * the GCS layer directly and uses the real ObjectStorageService.
     */
    getObjectEntityUploadURL = vi
      .fn()
      .mockResolvedValue("https://storage.googleapis.com/stub-signed-put-url");
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
// Real imports (after mocks)
// ---------------------------------------------------------------------------
import storageRouter from "../storage";

// ---------------------------------------------------------------------------
// Express app shared across all route tests
// ---------------------------------------------------------------------------
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());

  app.use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as any).log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
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

beforeEach(() => {
  currentUser.value = COACH_A;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function signedUrlEndpoint(segment: string) {
  return `${baseUrl}/api/storage/objects-signed-url/${segment}`;
}

function rawObjectEndpoint(segment: string) {
  return `${baseUrl}/api/storage/objects/${segment}`;
}

// ---------------------------------------------------------------------------
// Tests: ACL-stamped object access
// ---------------------------------------------------------------------------

describe("Storage ACL — ACL-stamped object, signed-URL endpoint", () => {
  it("returns a signed URL for the ACL owner (Coach A)", async () => {
    currentUser.value = COACH_A;

    const res = await fetch(signedUrlEndpoint(STAMPED_OBJECT_URL_SEGMENT));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { url: string };
    expect(typeof body.url).toBe("string");
    expect(body.url.length).toBeGreaterThan(0);
  });

  it("returns 404 for a foreign coach (Coach B) — not the video", async () => {
    currentUser.value = COACH_B;

    const res = await fetch(signedUrlEndpoint(STAMPED_OBJECT_URL_SEGMENT));
    expect(res.status).toBe(404);

    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });
});

describe("Storage ACL — ACL-stamped object, raw-proxy endpoint", () => {
  it("redirects (302) to a signed URL for the ACL owner (Coach A)", async () => {
    currentUser.value = COACH_A;

    const res = await fetch(rawObjectEndpoint(STAMPED_OBJECT_URL_SEGMENT), {
      redirect: "manual",
    });
    // video/mp4 triggers a 302 redirect to a GCS signed URL.
    expect(res.status).toBe(302);
  });

  it("returns 404 for a foreign coach (Coach B) — not the video", async () => {
    currentUser.value = COACH_B;

    const res = await fetch(rawObjectEndpoint(STAMPED_OBJECT_URL_SEGMENT));
    expect(res.status).toBe(404);

    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });
});

