import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  broadcastList: vi.fn(),
  broadcastInsert: vi.fn(),
  broadcastBind: vi.fn(),
  videoUpdate: vi.fn(),
  streamList: vi.fn(),
  streamInsert: vi.fn(),
}));

vi.mock("googleapis", () => ({
  google: {
    auth: {
      OAuth2: vi.fn().mockImplementation(function OAuth2() {
        return { setCredentials: vi.fn() };
      }),
    },
    youtube: vi.fn().mockReturnValue({
      liveBroadcasts: {
        list: mocks.broadcastList,
        insert: mocks.broadcastInsert,
        bind: mocks.broadcastBind,
      },
      liveStreams: {
        list: mocks.streamList,
        insert: mocks.streamInsert,
      },
      videos: {
        update: mocks.videoUpdate,
      },
    }),
  },
}));

import { ensureLiveResources } from "../youtubeClient";

describe("ensureLiveResources", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GOOGLE_CLIENT_ID = "test-client";
    process.env.GOOGLE_CLIENT_SECRET = "test-secret";

    mocks.broadcastList.mockResolvedValue({ data: { items: [] } });
    mocks.broadcastInsert.mockResolvedValue({
      data: { id: "broadcast-1", contentDetails: {}, status: { lifeCycleStatus: "upcoming" } },
    });
    mocks.streamList.mockResolvedValue({ data: { items: [] } });
    mocks.streamInsert.mockResolvedValue({
      data: {
        id: "stream-1",
        cdn: {
          ingestionInfo: {
            ingestionAddress: "rtmps://example.test/live2",
            streamName: "secret-stream-name",
          },
        },
      },
    });
    mocks.broadcastBind.mockResolvedValue({ data: {} });
    mocks.videoUpdate.mockResolvedValue({ data: {} });
  });

  it("supplies YouTube's required scheduled start time for an immediate auto-start broadcast", async () => {
    const before = Date.now();

    await ensureLiveResources("refresh-token");

    const request = mocks.broadcastInsert.mock.calls[0]?.[0];
    const scheduled = Date.parse(request.requestBody.snippet.scheduledStartTime);
    expect(Number.isFinite(scheduled)).toBe(true);
    expect(scheduled).toBeGreaterThan(before);
    expect(scheduled).toBeLessThanOrEqual(before + 31_000);
    expect(request.requestBody.contentDetails.enableAutoStart).toBe(true);
    expect(request.requestBody.contentDetails.enableEmbed).toBe(false);
    expect(request.requestBody.status.privacyStatus).toBe("unlisted");
    expect(mocks.videoUpdate).toHaveBeenCalledWith({
      part: ["status"],
      requestBody: {
        id: "broadcast-1",
        status: {
          privacyStatus: "unlisted",
          embeddable: true,
          selfDeclaredMadeForKids: false,
        },
      },
    });
  });
});