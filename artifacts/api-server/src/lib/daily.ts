import { logger } from "./logger";

const DAILY_API = "https://api.daily.co/v1";

function dailyKey(): string {
  const key = process.env.DAILY_API_KEY;
  if (!key) throw new Error("DAILY_API_KEY is not configured");
  return key;
}

async function dailyRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${DAILY_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${dailyKey()}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) {
    throw new Error(`Daily API ${response.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }
  return body as T;
}

export type DailyRoom = { name: string; url: string; privacy?: string };
export type DailyToken = { token: string };
export type DailyRecording = {
  id: string;
  room_name?: string;
  status?: string;
  duration?: number;
  start_ts?: number;
};

export async function createDailyRoom(roomName: string): Promise<DailyRoom> {
  return dailyRequest<DailyRoom>("/rooms", {
    method: "POST",
    body: JSON.stringify({
      name: roomName,
      privacy: "private",
      properties: {
        enable_recording: "cloud",
        start_video_off: false,
        start_audio_off: false,
      },
    }),
  });
}

export async function getDailyRoom(roomName: string): Promise<DailyRoom> {
  return dailyRequest<DailyRoom>(`/rooms/${encodeURIComponent(roomName)}`);
}

export async function createDailyMeetingToken(
  roomName: string,
  options: { owner: boolean; userId: string },
): Promise<DailyToken> {
  return dailyRequest<DailyToken>("/meeting-tokens", {
    method: "POST",
    body: JSON.stringify({
      properties: {
        room_name: roomName,
        user_id: options.userId,
        is_owner: options.owner,
        exp: Math.floor(Date.now() / 1000) + (options.owner ? 24 * 3600 : 15 * 60),
        enable_recording: options.owner ? "cloud" : undefined,
        permissions: options.owner ? undefined : { canSend: [] },
      },
    }),
  });
}

export async function stopDailyRecording(roomName: string): Promise<void> {
  try {
    await dailyRequest(`/rooms/${encodeURIComponent(roomName)}/recordings/stop`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/Daily API (400|404|409)|no active recording|already stopped/i.test(message)) throw error;
  }
}

export async function startDailyRtmp(
  roomName: string,
  ingestionAddress: string,
  streamName: string,
): Promise<void> {
  // Daily expects the complete RTMP URL, while YouTube returns its endpoint
  // and secret stream name separately. Normalize both sides without ever
  // logging or returning the resulting URL.
  const rtmpUrl = `${ingestionAddress.replace(/\/+$/, "")}/${streamName.replace(/^\/+/, "")}`;
  try {
    await dailyRequest(`/rooms/${encodeURIComponent(roomName)}/live-streaming/start`, {
      method: "POST",
      body: JSON.stringify({
        rtmpUrl,
        width: 1280,
        height: 720,
        fps: 30,
        layout: { preset: "single-participant" },
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/Daily API (400|409)|already (active|streaming)|live stream.*active/i.test(message)) throw error;
  }
}

export async function stopDailyRtmp(roomName: string): Promise<void> {
  try {
    await dailyRequest(`/rooms/${encodeURIComponent(roomName)}/live-streaming/stop`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  } catch (error) {
    // Stopping is deliberately idempotent: Daily reports no active stream as
    // a 404/409 (or an equivalent descriptive error) after a prior stop.
    const message = error instanceof Error ? error.message : String(error);
    if (!/Daily API (404|409)|no active stream|already stopped/i.test(message)) throw error;
  }
}

export async function listDailyRecordings(roomName: string): Promise<DailyRecording[]> {
  const result = await dailyRequest<{ data?: DailyRecording[] }>(
    `/recordings?room_name=${encodeURIComponent(roomName)}`,
  );
  return result.data ?? [];
}

export async function getDailyRecording(recordingId: string): Promise<DailyRecording> {
  return dailyRequest<DailyRecording>(`/recordings/${encodeURIComponent(recordingId)}`);
}

export async function downloadDailyRecording(recording: DailyRecording): Promise<Response> {
  const access = await dailyRequest<{ download_link?: string }>(
    `/recordings/${encodeURIComponent(recording.id)}/access-link?valid_for_secs=3600`,
  );
  if (!access.download_link || !access.download_link.startsWith("https://")) {
    throw new Error("Daily recording has no safe HTTPS download link");
  }
  const response = await fetch(access.download_link, { redirect: "error" });
  if (!response.ok || !response.body) {
    throw new Error(`Daily recording download failed (${response.status})`);
  }
  return response;
}

export function dailyConfigured(): boolean {
  return Boolean(process.env.DAILY_API_KEY);
}

export function logDailyError(err: unknown, context: Record<string, unknown>): void {
  logger.warn({ err, ...context }, "Daily API request failed");
}