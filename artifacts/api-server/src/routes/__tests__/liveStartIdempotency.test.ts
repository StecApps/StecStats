import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const { createSessionMock, currentOwnerId } = vi.hoisted(() => ({
  createSessionMock: vi.fn(),
  currentOwnerId: { value: 41 },
}));

vi.mock("../../middlewares/requireAuth", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.appUser = { id: currentOwnerId.value } as any;
    next();
  },
}));

vi.mock("../../lib/entitlements", () => ({
  getEntitlementsForUser: vi.fn().mockResolvedValue({ plan: "pro" }),
  getEntitlements: vi.fn(),
  isPro: vi.fn().mockReturnValue(true),
}));

vi.mock("../../lib/liveStream", () => ({
  liveStreamRegistry: {
    createSession: createSessionMock,
    getOrResumeSession: vi.fn(),
    endSession: vi.fn(),
  },
  getIceServers: vi.fn().mockResolvedValue([]),
  getTurnAvailable: vi.fn().mockReturnValue(false),
}));

import liveRouter from "../live";

const app = express();
app.use(express.json());
app.use("/api", liveRouter);

describe("POST /api/live/start idempotency", () => {
  beforeEach(() => {
    process.env.SESSION_SECRET = "live-start-test-secret";
    currentOwnerId.value = 41;
    createSessionMock.mockReset();
    createSessionMock.mockImplementation(async (_meta, preferredCode?: string) => ({
      code: preferredCode ?? "RANDOM1",
    }));
  });

  it("derives the same preferred code for retries from the same owner and request ID", async () => {
    const body = {
      opponent: "Rivals",
      teamName: "Home",
      requestId: "retry-request-id-0001",
    };
    const first = await request(app).post("/api/live/start").send(body);
    const second = await request(app).post("/api/live/start").send(body);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.code).toBe(second.body.code);
    expect(first.body.code).toMatch(/^[A-F0-9]{16}$/);
    expect(createSessionMock.mock.calls[0]?.[1]).toBe(createSessionMock.mock.calls[1]?.[1]);
  });

  it("binds the derived code to the authenticated owner", async () => {
    const body = {
      opponent: "Rivals",
      teamName: "Home",
      requestId: "shared-request-id-001",
    };
    const first = await request(app).post("/api/live/start").send(body);
    currentOwnerId.value = 42;
    const second = await request(app).post("/api/live/start").send(body);

    expect(first.body.code).not.toBe(second.body.code);
  });

  it.each([
    "short",
    "contains spaces 123",
    "x".repeat(129),
  ])("rejects invalid request ID %j", async (requestId) => {
    const response = await request(app).post("/api/live/start").send({
      opponent: "Rivals",
      teamName: "Home",
      requestId,
    });

    expect(response.status).toBe(400);
    expect(createSessionMock).not.toHaveBeenCalled();
  });

  it("keeps legacy clients random by omitting the preferred code", async () => {
    const response = await request(app).post("/api/live/start").send({
      opponent: "Rivals",
      teamName: "Home",
    });

    expect(response.status).toBe(200);
    expect(createSessionMock).toHaveBeenCalledWith(
      { opponent: "Rivals", teamName: "Home" },
      undefined,
      41,
    );
  });
});