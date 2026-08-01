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

export function watchUrlForCode(code: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  return `${window.location.origin}${base}/watch/${code}`;
}
