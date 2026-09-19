const FALLBACK_ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

type IceServerCache = {
  servers: RTCIceServer[];
  turnAvailable: boolean;
};

let cachedIceServerData: IceServerCache | null = null;

export async function getIceServers(): Promise<RTCIceServer[]> {
  if (cachedIceServerData) return cachedIceServerData.servers;
  try {
    const res = await fetch("/api/live/ice-servers");
    if (!res.ok) {
      cachedIceServerData = { servers: FALLBACK_ICE_SERVERS, turnAvailable: false };
      return FALLBACK_ICE_SERVERS;
    }
    const data = await res.json();
    const servers = Array.isArray(data.iceServers) && data.iceServers.length > 0
      ? (data.iceServers as RTCIceServer[])
      : FALLBACK_ICE_SERVERS;
    cachedIceServerData = { servers, turnAvailable: Boolean(data.turnAvailable) };
    return servers;
  } catch {
    cachedIceServerData = { servers: FALLBACK_ICE_SERVERS, turnAvailable: false };
    return FALLBACK_ICE_SERVERS;
  }
}

/**
 * Returns whether the server has a working TURN relay configured.
 * Fetches from /api/live/ice-servers if the cache is empty (getIceServers is
 * a no-op when the cache is warm), then reads the module-level state.
 */
export async function getTurnAvailable(): Promise<boolean> {
  await getIceServers();
  // Cast to break TypeScript's module-variable narrowing: after the await,
  // cachedIceServerData is always set (getIceServers always populates it).
  return (cachedIceServerData as IceServerCache | null)?.turnAvailable ?? false;
}

/**
 * Bypasses the module-level cache and force-fetches /api/live/ice-servers.
 * Use this for periodic mid-session TURN health checks so the cached result
 * from go-live time doesn't mask a relay outage that happened during the game.
 */
export async function refreshTurnAvailable(): Promise<boolean> {
  cachedIceServerData = null;
  return getTurnAvailable();
}

export function liveWsUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/live/ws`;
}

export type LiveStatus = {
  active: boolean;
  opponent: string;
  teamName: string;
  viewerCount: number;
  teamScore: number;
  opponentScore: number;
  /** The broadcaster transport selected for this session. */
  videoMode?: "daily" | "webrtc" | "mjpeg" | "none";
};

export async function startLiveSession(opponent: string, teamName: string): Promise<string> {
  const res = await fetch("/api/live/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ opponent, teamName }),
  });
  if (!res.ok) throw new Error("Failed to start live session");
  const data = await res.json();
  return data.code as string;
}

export async function stopLiveSession(code: string): Promise<void> {
  await fetch(`/api/live/${code}/stop`, { method: "POST" }).catch(() => {});
}

export async function getLiveStatus(code: string): Promise<LiveStatus | null> {
  const res = await fetch(`/api/live/${code}/status`);
  if (!res.ok) return null;
  return res.json();
}

export type DailyViewerCredentials = {
  roomUrl: string;
  token: string;
};

/**
 * Fetches the short-lived, receive-only Daily credentials for a public invite.
 * The API owns room membership and token TTL; the viewer never receives the
 * Daily API key.
 */
export async function getDailyViewerCredentials(code: string): Promise<DailyViewerCredentials> {
  const res = await fetch(`/api/live/${encodeURIComponent(code)}/daily-token`);
  if (!res.ok) throw new Error("Live video is unavailable");
  const data = await res.json() as Partial<DailyViewerCredentials>;
  if (typeof data.roomUrl !== "string" || typeof data.token !== "string") {
    throw new Error("Live video credentials are invalid");
  }
  return { roomUrl: data.roomUrl, token: data.token };
}

export function watchUrlForCode(code: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  return `${window.location.origin}${base}/watch/${code}`;
}
