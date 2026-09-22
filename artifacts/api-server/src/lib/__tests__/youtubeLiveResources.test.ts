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

import { ensureLiveResources, YouTubeAuthError, YouTubeLiveError } from "../youtubeClient";

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

  it("reports a nested liveStreamingNotEnabled response as a channel setup issue", async () => {
    mocks.broadcastInsert.mockRejectedValue({
      response: {
        status: 403,
        data: {
          error: {
            code: 403,
            message: "The user is not enabled for live streaming.",
            errors: [{ reason: "liveStreamingNotEnabled" }],
          },
        },
      },
    });

    const error = await ensureLiveResources("refresh-token").catch((err: unknown) => err);

    expect(error).toBeInstanceOf(YouTubeAuthError);
    expect((error as Error).message).toMatch(/Live is not enabled/i);
  });

  it("reports a quota 403 without exposing Google's raw HTML or blaming the token", async () => {
    mocks.broadcastInsert.mockRejectedValue({
      response: {
        status: 403,
        data: {
          error: {
            code: 403,
            message: "The request cannot be completed because you have exceeded your quota.",
            errors: [{ reason: "quotaExceeded" }],
          },
        },
      },
    });

    const error = await ensureLiveResources("refresh-token").catch((err: unknown) => err);

    expect(error).toBeInstanceOf(YouTubeLiveError);
    expect(error).not.toBeInstanceOf(YouTubeAuthError);
    expect((error as YouTubeLiveError).code).toBe("YOUTUBE_QUOTA_EXCEEDED");
    expect((error as Error).message).toMatch(/daily API quota/i);
    expect((error as Error).message).not.toContain("<a");
  });
});
