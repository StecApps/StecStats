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
    scope: ["https://www.googleapis.com/auth/youtube.upload"],
    state,
    prompt: "select_account consent",
  });
}

export async function exchangeCode(code: string): Promise<{ refreshToken: string | null }> {
  const client = makeOAuth2Client();
  const { tokens } = await client.getToken(code);
  return { refreshToken: tokens.refresh_token ?? null };
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
