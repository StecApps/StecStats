/**
 * Storage ACL — cross-tenant access regression test
 *
 * Verifies that a second authenticated user (Coach B) cannot retrieve a
 * signed URL or stream the raw object for a video owned by Coach A.
 *
 * Both the signed-URL endpoint  (GET /api/storage/objects-signed-url/*)
 * and the raw proxy endpoint    (GET /api/storage/objects/*)
 * must return 404 for the foreign user.
 *
 * The object-storage layer and DB are replaced with minimal in-memory mocks
 * so no real GCS bucket or database is required.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";

// ---------------------------------------------------------------------------
// Test fixtures + shared mutable "current user".
//
// vi.hoisted() runs before vi.mock() factories AND before module-level const
// assignments, so all fixtures must live inside it if they are referenced by
// a mock factory.
// ---------------------------------------------------------------------------
const {
  COACH_A,
  COACH_B,
  OWNED_OBJECT_PATH,
  OWNED_OBJECT_URL_SEGMENT,
  OWNED_LOWLIGHT_PATH,
  OWNED_LOWLIGHT_URL_SEGMENT,
  currentUser,
} = vi.hoisted(() => {
    const COACH_A = { id: 1, clerkUserId: "clerk_coach_a", email: "coach-a@example.com" };
    const COACH_B = { id: 2, clerkUserId: "clerk_coach_b", email: "coach-b@example.com" };
    // The private object path that Coach A owns.
    const OWNED_OBJECT_PATH = "/objects/private/coach-a-game.mp4";
    // Wildcard portion used in the URL (strips leading /objects/)
    const OWNED_OBJECT_URL_SEGMENT = "private/coach-a-game.mp4";
    // Lowlight object that Coach A owns.
    const OWNED_LOWLIGHT_PATH = "/objects/private/coach-a-lowlight.mp4";
    const OWNED_LOWLIGHT_URL_SEGMENT = "private/coach-a-lowlight.mp4";
    // Mutable ref: set to the current requesting user before each fetch.
    const currentUser = { value: COACH_A as typeof COACH_A };
    return {
      COACH_A,
      COACH_B,
      OWNED_OBJECT_PATH,
      OWNED_OBJECT_URL_SEGMENT,
      OWNED_LOWLIGHT_PATH,
      OWNED_LOWLIGHT_URL_SEGMENT,
      currentUser,
    };
  });

// ---------------------------------------------------------------------------
// Module mocks — declared before any imports that trigger them.
// ---------------------------------------------------------------------------

vi.mock("@workspace/db", () => ({
  db: {
    query: {
      gamesTable: {
        /**
         * Return a game row only when the requesting user is Coach A AND the
         * requested path matches one of the game's video/highlight/lowlight paths.
         * The storage route calls:
         *   db.query.gamesTable.findFirst({ where: and(eq(ownerId, user.id), or(...paths)) })
         * We cannot inspect the drizzle `where` tree, so we key off the
         * shared currentUser ref that requireAuth sets before each request,
         * and expose both owned paths so each test scenario resolves correctly.
         */
        findFirst: vi.fn().mockImplementation(async () => {
          if (currentUser.value.id === COACH_A.id) {
            return {
              id: 10,
              ownerId: COACH_A.id,
              videoObjectPath: OWNED_OBJECT_PATH,
              highlightObjectPath: null,
              lowlightObjectPath: OWNED_LOWLIGHT_PATH,
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
  // Drizzle column references — only need to be truthy objects.
  gamesTable: {
    ownerId: "owner_id",
    videoObjectPath: "video_object_path",
    highlightObjectPath: "highlight_object_path",
    lowlightObjectPath: "lowlight_object_path",
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

// Mock the object-storage layer so no GCS credentials are needed.
// getObjectEntityFile always succeeds (the object "exists" in storage).
// canAccessObjectEntity returns false — the ACL layer grants no extra access.
// getObjectEntitySignedURL returns a dummy URL so we can confirm Coach A gets one.
vi.mock("../../lib/objectStorage", () => {
  // Minimal mock of a GCS File object — only the fields the storage route uses.
  const mockObjectFile = {
    getMetadata: vi.fn().mockResolvedValue([
      { contentType: "video/mp4", size: 10_000_000 },
    ]),
    createReadStream: vi.fn().mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Readable } = require("stream");
      const s = new Readable({ read() {} });
      process.nextTick(() => s.push(null));
      return s;
    }),
  };

  // Must be a real class so `new ObjectStorageService()` in storage.ts works.
  class ObjectStorageService {
    getObjectEntityFile = vi.fn().mockResolvedValue(mockObjectFile);
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
// Real imports (after mocks are registered)
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

  // The storage route uses req.log (injected by pino-http in production).
  // Provide a silent stub so the route doesn't throw when it logs.
  app.use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as any).log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    next();
  });

  // Mirror the prefix used in the real app.ts
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

// Reset to Coach A before every test so individual tests can override.
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
// Tests
// ---------------------------------------------------------------------------

describe("Storage ACL — signed-URL endpoint (GET /api/storage/objects-signed-url/*)", () => {
  it("returns a signed URL for the owner (Coach A)", async () => {
    currentUser.value = COACH_A;

    const res = await fetch(signedUrlEndpoint(OWNED_OBJECT_URL_SEGMENT));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { url: string };
    expect(typeof body.url).toBe("string");
    expect(body.url.length).toBeGreaterThan(0);
  });

  it("returns 404 when a different coach (Coach B) requests the same path", async () => {
    currentUser.value = COACH_B;

    const res = await fetch(signedUrlEndpoint(OWNED_OBJECT_URL_SEGMENT));
    expect(res.status).toBe(404);

    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });
});

describe("Storage ACL — raw proxy endpoint (GET /api/storage/objects/*)", () => {
  it("redirects to a signed URL for the owner (Coach A)", async () => {
    currentUser.value = COACH_A;

    // fetch with redirect:manual so we can inspect the 302 without following it.
    const res = await fetch(rawObjectEndpoint(OWNED_OBJECT_URL_SEGMENT), {
      redirect: "manual",
    });
    // video/mp4 content type triggers a 302 redirect to GCS signed URL.
    expect(res.status).toBe(302);
  });

  it("returns 404 when a different coach (Coach B) requests the same path", async () => {
    currentUser.value = COACH_B;

    const res = await fetch(rawObjectEndpoint(OWNED_OBJECT_URL_SEGMENT));
    expect(res.status).toBe(404);

    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Lowlight ownership checks
// ---------------------------------------------------------------------------

describe("Storage ACL — lowlight files on raw proxy endpoint (GET /api/storage/objects/*)", () => {
  it("allows the owner (Coach A) to access their own lowlight file", async () => {
    currentUser.value = COACH_A;

    const res = await fetch(rawObjectEndpoint(OWNED_LOWLIGHT_URL_SEGMENT), {
      redirect: "manual",
    });
    // video/mp4 triggers a 302 redirect to the GCS signed URL for authorised users.
    expect(res.status).toBe(302);
  });

  it("returns 404 when a different coach (Coach B) requests the lowlight file", async () => {
    currentUser.value = COACH_B;

    const res = await fetch(rawObjectEndpoint(OWNED_LOWLIGHT_URL_SEGMENT));
    expect(res.status).toBe(404);

    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });
});

describe("Storage ACL — lowlight files on signed-URL endpoint (GET /api/storage/objects-signed-url/*)", () => {
  it("returns a signed URL for the owner (Coach A) for a lowlight file", async () => {
    currentUser.value = COACH_A;

    const res = await fetch(signedUrlEndpoint(OWNED_LOWLIGHT_URL_SEGMENT));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { url: string };
    expect(typeof body.url).toBe("string");
    expect(body.url.length).toBeGreaterThan(0);
  });

  it("returns 404 when a different coach (Coach B) requests a signed URL for a lowlight file", async () => {
    currentUser.value = COACH_B;

    const res = await fetch(signedUrlEndpoint(OWNED_LOWLIGHT_URL_SEGMENT));
    expect(res.status).toBe(404);

    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });
});
