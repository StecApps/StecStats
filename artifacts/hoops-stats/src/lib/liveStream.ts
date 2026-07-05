const FALLBACK_ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

let cachedIceServers: RTCIceServer[] | null = null;

export async function getIceServers(): Promise<RTCIceServer[]> {
  if (cachedIceServers) return cachedIceServers;
  try {
    const res = await fetch("/api/live/ice-servers");
    if (!res.ok) return FALLBACK_ICE_SERVERS;
    const data = await res.json();
    if (!Array.isArray(data.iceServers) || data.iceServers.length === 0) {
      return FALLBACK_ICE_SERVERS;
    }
    cachedIceServers = data.iceServers as RTCIceServer[];
    return cachedIceServers;
  } catch {
    return FALLBACK_ICE_SERVERS;
  }
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
