/**
 * Storage concat-segments ACL — cross-tenant regression test
 *
 * Verifies that POST /api/storage/concat-segments returns 403 when any of
 * the requested segment paths is owned by a different coach.
 *
 * Both the DB ownership path (gamesTable row) and the ACL-metadata fallback
 * (canAccessObjectEntity) are covered.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import type { EventEmitter } from "events";

// ---------------------------------------------------------------------------
// Test fixtures — hoisted so mock factories can reference them
// ---------------------------------------------------------------------------
const { COACH_A, COACH_B, SEG_A1, SEG_A2, currentUser } = vi.hoisted(() => {
  const COACH_A = { id: 1, clerkUserId: "clerk_coach_a", email: "coach-a@example.com" };
  const COACH_B = { id: 2, clerkUserId: "clerk_coach_b", email: "coach-b@example.com" };

  // Two segment paths that belong to Coach A.
  const SEG_A1 = "/objects/private/coach-a-half1.mp4";
  const SEG_A2 = "/objects/private/coach-a-half2.mp4";

  const currentUser = { value: COACH_A as typeof COACH_A };
  return { COACH_A, COACH_B, SEG_A1, SEG_A2, currentUser };
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("@workspace/db", () => ({
  db: {
    query: {
      gamesTable: {
        // Returns a game row iff the requesting user is Coach A (the owner).
        findFirst: vi.fn().mockImplementation(async () => {
          if (currentUser.value.id === COACH_A.id) {
            return {
              id: 10,
              ownerId: COACH_A.id,
              videoObjectPath: SEG_A1,
              highlightObjectPath: SEG_A2,
            };
          }
          return undefined;
        }),
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

// Minimal object-storage mock — canAccessObjectEntity always returns false so
// the ACL fallback path also denies cross-tenant access.
vi.mock("../../lib/objectStorage", () => {
  const mockObjectFile = {
    getMetadata: vi.fn().mockResolvedValue([{ contentType: "video/mp4", size: 10_000_000 }]),
    createReadStream: vi.fn(),
  };

  class ObjectStorageService {
    getObjectEntityFile = vi.fn().mockResolvedValue(mockObjectFile);
    canAccessObjectEntity = vi.fn().mockResolvedValue(false);
    getObjectEntitySignedURL = vi
      .fn()
      .mockResolvedValue("https://storage.googleapis.com/signed-url-stub");
    uploadLocalFileAsObjectEntity = vi
      .fn()
      .mockResolvedValue("/objects/private/concat-output.mp4");
    trySetObjectEntityAclPolicy = vi.fn().mockResolvedValue(undefined);
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

// Mock child_process.spawn so the ffmpeg concat step is skipped in the
// positive (owner) test — we only care that the request passes the ACL gate.
vi.mock("child_process", () => ({
  spawn: vi.fn().mockImplementation(() => {
    // Return a minimal EventEmitter-like process that exits cleanly.
    const { EventEmitter } = require("events");
    const proc = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter;
      stdout: EventEmitter;
    };
    proc.stderr = new EventEmitter();
    proc.stdout = new EventEmitter();
    // Emit successful exit on the next tick.
    process.nextTick(() => proc.emit("close", 0));
    return proc;
  }),
}));

// Mock fs.promises so mkdtemp / writeFile / rm don't touch the real filesystem.
vi.mock("fs", async () => {
  // Keep the real Readable from stream for other parts of the code.
  return {
    promises: {
      mkdtemp: vi.fn().mockResolvedValue("/tmp/concat-test-stub"),
      writeFile: vi.fn().mockResolvedValue(undefined),
      rm: vi.fn().mockResolvedValue(undefined),
    },
    default: { promises: {} },
  };
});

// ---------------------------------------------------------------------------
// Real imports (after mocks)
// ---------------------------------------------------------------------------
import storageRouter from "../storage";

// ---------------------------------------------------------------------------
// Express app shared across all tests
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
function concatEndpoint() {
  return `${baseUrl}/api/storage/concat-segments`;
}

async function postConcat(segmentPaths: string[]) {
  return fetch(concatEndpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ segmentPaths }),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Storage ACL — POST /api/storage/concat-segments", () => {
  it("returns 403 when Coach B requests a concat of segments owned by Coach A", async () => {
    currentUser.value = COACH_B;

    const res = await postConcat([SEG_A1, SEG_A2]);
    expect(res.status).toBe(403);

    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/forbidden/i);
  });

  it("returns 403 when only one of the two segments belongs to a foreign coach", async () => {
    // Coach B owns neither SEG_A1 nor SEG_A2 — but here we simulate a mixed
    // payload: Coach B has a segment of their own plus one of Coach A's.
    // The mock returns undefined for Coach B on ANY segment lookup, so both
    // paths will fail the ownership check — the first one triggers the 403.
    currentUser.value = COACH_B;

    const COACH_B_SEG = "/objects/private/coach-b-half1.mp4";
    // Even if COACH_B_SEG passed auth, SEG_A1 must still be rejected.
    const res = await postConcat([COACH_B_SEG, SEG_A1]);
    expect(res.status).toBe(403);

    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/forbidden/i);
  });

  it("passes the ownership gate for the segment owner (Coach A) and returns a merged path", async () => {
    currentUser.value = COACH_A;

    const res = await postConcat([SEG_A1, SEG_A2]);
    // The ownership check passes; ffmpeg is mocked to exit 0; upload returns a path.
    expect(res.status).toBe(200);

    const body = (await res.json()) as { videoObjectPath: string };
    expect(typeof body.videoObjectPath).toBe("string");
    expect(body.videoObjectPath.length).toBeGreaterThan(0);
  });

  it("returns 400 for fewer than 2 segments without reaching the ownership check", async () => {
    currentUser.value = COACH_B;

    const res = await postConcat([SEG_A1]); // only 1 segment
    expect(res.status).toBe(400);
  });
});
