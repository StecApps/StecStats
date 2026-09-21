import { google } from "googleapis";
import type { Readable } from "stream";

export class YouTubeAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YouTubeAuthError";
  }
}

export function isYoutubeConfigured(): boolean {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function getCallbackUrl(): string {
  if (process.env.YOUTUBE_CALLBACK_URL) return process.env.YOUTUBE_CALLBACK_URL;
  const domain = process.env.REPLIT_DOMAINS?.split(",")[0] ?? "";
  return `https://${domain}/api/auth/youtube/callback`;
}

function makeOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID!,
    process.env.GOOGLE_CLIENT_SECRET!,
    getCallbackUrl(),
  );
}

export function getAuthUrl(state: string): string {
  const client = makeOAuth2Client();
  return client.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/youtube.force-ssl"],
    state,
    prompt: "select_account consent",
  });
}

export type YouTubeLiveResources = {
  broadcastId: string;
  streamId: string;
  videoId: string;
  watchUrl: string;
  rtmpUrl: string;
  streamKey: string;
};

function youtubeAuth(refreshToken: string) {
  const oauth2Client = makeOAuth2Client();
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  return google.youtube({ version: "v3", auth: oauth2Client });
}

function mapYouTubeError(err: unknown): never {
  const status = (err as { status?: number; code?: number })?.status ??
    (err as { status?: number; code?: number })?.code;
  const reason = String((err as { errors?: Array<{ reason?: string }> })?.errors?.[0]?.reason ?? "");
  if (status === 401 || status === 403) {
    if (/liveStreamingNotEnabled/i.test(reason)) {
      throw new YouTubeAuthError("YouTube Live is not enabled for this account. Enable live streaming or reconnect YouTube.");
    }
    throw new YouTubeAuthError("YouTube token expired or revoked — please reconnect");
  }
  throw err;
}

export async function ensureLiveResources(refreshToken: string, existing?: {
  broadcastId?: string | null; streamId?: string | null;
  onBroadcastReady?: (broadcastId: string) => Promise<void>;
  onStreamReady?: (streamId: string) => Promise<void>;
}): Promise<YouTubeLiveResources> {
  const youtube = youtubeAuth(refreshToken);
  try {
    let broadcast = existing?.broadcastId
      ? (await youtube.liveBroadcasts.list({ part: ["id", "snippet", "status", "contentDetails"], id: [existing.broadcastId] })).data.items?.[0]
      : undefined;
    if (broadcast?.status?.lifeCycleStatus === "complete" ||
        broadcast?.status?.lifeCycleStatus === "revoked") {
      broadcast = undefined;
    }
    if (!broadcast) {
      // YouTube requires scheduledStartTime even when encoder ingestion uses
      // enableAutoStart. Keep it slightly in the future so clock skew cannot
      // make an otherwise immediate broadcast look invalid.
      const scheduledStartTime = new Date(Date.now() + 30_000).toISOString();
      broadcast = (await youtube.liveBroadcasts.insert({
        part: ["snippet", "status", "contentDetails"],
        requestBody: {
          snippet: {
            title: "StecStats Live",
            description: "Live game stream",
            scheduledStartTime,
          },
          status: { privacyStatus: "unlisted", selfDeclaredMadeForKids: false },
          contentDetails: {
            enableAutoStart: true,
            enableAutoStop: true,
            // Some channels reject enableEmbed during liveBroadcasts.insert
            // with invalidEmbedSetting even though the resulting video can be
            // made embeddable through the regular Videos API.
            enableEmbed: false,
            latencyPreference: "low",
            enableClosedCaptions: false,
          },
        },
      })).data;
    }
    const broadcastId = broadcast.id;
    if (!broadcastId) throw new Error("YouTube did not return a broadcast ID");
    await youtube.videos.update({
      part: ["status"],
      requestBody: {
        id: broadcastId,
        status: {
          privacyStatus: "unlisted",
          embeddable: true,
          selfDeclaredMadeForKids: false,
        },
      },
    });
    await existing?.onBroadcastReady?.(broadcastId);
    let stream = existing?.streamId
      ? (await youtube.liveStreams.list({ part: ["id", "cdn", "status"], id: [existing.streamId] })).data.items?.[0]
      : undefined;
    if (!stream) {
      stream = (await youtube.liveStreams.insert({
        part: ["snippet", "cdn", "contentDetails", "status"],
        requestBody: {
          snippet: { title: "StecStats Live" },
          cdn: { frameRate: "variable", ingestionType: "rtmp", resolution: "variable" },
        },
      })).data;
    }
    const streamId = stream.id;
    const ingestion = stream.cdn?.ingestionInfo;
    if (!streamId || !ingestion?.ingestionAddress || !ingestion.streamName) {
      throw new Error("YouTube did not return a usable RTMP ingest endpoint");
    }
    await existing?.onStreamReady?.(streamId);
    const bound = broadcast.contentDetails?.boundStreamId;
    if (bound !== streamId) {
      await youtube.liveBroadcasts.bind({ id: broadcastId, part: ["id", "contentDetails"], streamId });
    }
    return {
      broadcastId,
      streamId,
      videoId: broadcastId,
      watchUrl: `https://www.youtube.com/watch?v=${broadcastId}`,
      rtmpUrl: ingestion.ingestionAddress,
      streamKey: ingestion.streamName,
    };
  } catch (err) {
    return mapYouTubeError(err);
  }
}

export async function stopLiveBroadcast(refreshToken: string, broadcastId: string): Promise<void> {
  try {
    const youtube = youtubeAuth(refreshToken);
    await youtube.liveBroadcasts.transition({ id: broadcastId, broadcastStatus: "complete", part: ["id", "status"] });
  } catch (err) {
    const status = (err as { status?: number; code?: number })?.status ?? (err as { status?: number; code?: number })?.code;
    if (status !== 400 && status !== 404) mapYouTubeError(err);
  }
}

export async function exchangeCode(code: string): Promise<{ refreshToken: string | null }> {
  const client = makeOAuth2Client();
  const { tokens } = await client.getToken(code);
  return { refreshToken: tokens.refresh_token ?? null };
}

/**
 * Performs a cheap read-only probe (channels.list?mine=true&part=id) to verify
 * the stored refresh token is still valid.  Throws YouTubeAuthError if Google
 * rejects it with 401 or 403, so the caller can clear the DB record.
 *
 * @param timeoutMs  Maximum ms to wait for the Google API call (default 4 s).
 *                   The server-side default is kept short so the route handler
 *                   can send a response before the client's own 5 s AbortController
 *                   fires, giving the client a real JSON body instead of a network
 *                   abort.
 */
export async function probeToken(refreshToken: string, timeoutMs = 4_000): Promise<void> {
  const oauth2Client = makeOAuth2Client();
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  const youtube = google.youtube({ version: "v3", auth: oauth2Client });
  try {
    await youtube.channels.list(
      { part: ["id"], mine: true, maxResults: 1 },
      { timeout: timeoutMs },
    );
  } catch (err: unknown) {
    const status =
      (err as { status?: number; code?: number })?.status ??
      (err as { status?: number; code?: number })?.code;
    if (status === 401 || status === 403) {
      throw new YouTubeAuthError("YouTube token revoked or expired");
    }
    throw err;
  }
}

export async function revokeToken(refreshToken: string): Promise<void> {
  const client = makeOAuth2Client();
  try {
    await client.revokeToken(refreshToken);
  } catch {
    // Token may already be expired or revoked on Google's side — that's fine.
  }
}

export async function uploadToYoutube({
  refreshToken,
  title,
  description,
  privacyStatus,
  stream,
}: {
  refreshToken: string;
  title: string;
  description: string;
  privacyStatus: "public" | "unlisted" | "private";
  stream: Readable;
}): Promise<string> {
  const oauth2Client = makeOAuth2Client();
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  const youtube = google.youtube({ version: "v3", auth: oauth2Client });

  let response;
  try {
    response = await youtube.videos.insert(
      {
        part: ["snippet", "status"],
        requestBody: {
          snippet: {
            title,
            description,
            categoryId: "17",
          },
          status: {
            privacyStatus,
            selfDeclaredMadeForKids: false,
          },
        },
        media: {
          mimeType: "video/mp4",
          body: stream,
        },
      },
      {
        timeout: 10 * 60 * 1000,
      },
    );
  } catch (err: unknown) {
    const status = (err as { status?: number; code?: number })?.status ?? (err as { status?: number; code?: number })?.code;
    if (status === 401 || status === 403) {
      throw new YouTubeAuthError("YouTube token expired or revoked — please reconnect");
    }
    throw err;
  }

  const videoId = response.data.id;
  if (!videoId) throw new Error("YouTube did not return a video ID");

  return `https://youtu.be/${videoId}`;
}
