import { afterEach, describe, expect, it, vi } from "vitest";
import { startLiveSession, stopLiveSession } from "./liveStream";

afterEach(() => vi.unstubAllGlobals());

describe("browser live sessions", () => {
  it("requests WebRTC with the coach's session and keeps the broadcaster credential", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ code: "LIVE123", broadcasterToken: "signed-broadcaster-token" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(startLiveSession("Rivals", "Home", "coach-jwt")).resolves.toEqual({
      code: "LIVE123",
      broadcasterToken: "signed-broadcaster-token",
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/live/start", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer coach-jwt" }),
      body: JSON.stringify({ opponent: "Rivals", teamName: "Home", videoMode: "webrtc" }),
    }));
  });

  it("fails clearly if the server does not return the broadcaster credential", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ code: "LIVE123" }),
    }));
    await expect(startLiveSession("Rivals", "Home", "coach-jwt")).rejects.toThrow("credentials are missing");
  });

  it("authenticates stop and reports a failed stop", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal("fetch", fetchMock);
    await expect(stopLiveSession("LIVE123", "coach-jwt")).rejects.toThrow("Could not end");
    expect(fetchMock).toHaveBeenCalledWith("/api/live/LIVE123/stop", expect.objectContaining({
      headers: { Authorization: "Bearer coach-jwt" },
    }));
  });
});