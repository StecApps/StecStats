import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadDailyRecording } from "../daily";

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
});