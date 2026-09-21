import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadDailyRecording, startDailyRtmp, stopDailyRtmp } from "../daily";

describe("Daily recording import safety", () => {
  beforeEach(() => {
    process.env.DAILY_API_KEY = "test-key";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.DAILY_API_KEY;
  });

  it("rejects a non-HTTPS access link before downloading it", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(
      JSON.stringify({ download_link: "http://127.0.0.1/admin" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    await expect(downloadDailyRecording({
      id: "rec-1",
      status: "finished",
    })).rejects.toThrow("safe HTTPS");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("requires Daily to return a download link", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(
      JSON.stringify({ expires: 123 }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    await expect(downloadDailyRecording({
      id: "rec-2",
      status: "finished",
    })).rejects.toThrow("safe HTTPS");
  });

  it("uses Daily's documented live-streaming start request shape", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    await startDailyRtmp("room/name", "rtmps://a.example/live/", "/secret-key");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.daily.co/v1/rooms/room%2Fname/live-streaming/start");
    expect(JSON.parse(String(init?.body))).toEqual({
      rtmpUrl: "rtmps://a.example/live/secret-key",
      width: 1280,
      height: 720,
      fps: 30,
      layout: { preset: "default", max_cam_streams: 1 },
    });
  });

  it("uses the documented stop path and treats an already-stopped stream as success", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "no active stream" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(stopDailyRtmp("room/name")).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.daily.co/v1/rooms/room%2Fname/live-streaming/stop");
  });
});