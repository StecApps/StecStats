/**
 * Fetches ICE server config from the API for WebRTC peer connections.
 *
 * Falls back to Google's public STUN server when:
 *   - the API is unreachable (network error)
 *   - the response is not OK
 *   - the response body lacks a valid `iceServers` array
 *
 * The fallback guarantees that a peer connection attempt is always made
 * (STUN-only, no relay), so the app never crashes on a missing TURN server.
 * A TURN relay warning is surfaced separately in the broadcast UI.
 *
 * Caching: results are cached per-apiBase for 60 seconds. In-flight fetches
 * are deduplicated per-apiBase so that N concurrent callers during a
 * WS-reconnect storm share a single network request instead of each blocking
 * the JS thread. The per-base key ensures a different API endpoint always
 * gets its own request (no cross-base contamination in tests or multi-tenant
 * scenarios).
 */

export const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  servers: RTCIceServer[];
  expiry: number;
}

// Per-apiBase cache: avoids cross-contamination between different endpoints
// and makes the cache trivially resetable in tests via resetIceServerCache().
const cache = new Map<string, CacheEntry>();
// Per-apiBase in-flight promise: callers with the same apiBase share one fetch.
const inFlight = new Map<string, Promise<RTCIceServer[]>>();

export async function fetchIceServers(apiBase: string): Promise<RTCIceServer[]> {
  // Return cached value while still fresh.
  const entry = cache.get(apiBase);
  if (entry && Date.now() < entry.expiry) return entry.servers;

  // Deduplicate: if a fetch for this apiBase is already in-flight, piggyback.
  const existing = inFlight.get(apiBase);
  if (existing) return existing;

  const promise = (async (): Promise<RTCIceServer[]> => {
    let servers: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
    try {
      const res = await fetch(`${apiBase}/api/live/ice-servers`);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
          servers = data.iceServers as RTCIceServer[];
        }
      }
    } catch {
      // Network error — fall through to STUN fallback
    }
    cache.set(apiBase, { servers, expiry: Date.now() + CACHE_TTL_MS });
    return servers;
  })();

  inFlight.set(apiBase, promise);
  try {
    return await promise;
  } finally {
    // Clear the in-flight reference so the next call after cache expiry
    // can issue a fresh fetch rather than waiting on a settled promise.
    inFlight.delete(apiBase);
  }
}

/**
 * Clears the ICE-server cache and any in-flight promises.
 * Intended for use in tests only — call in beforeEach to prevent
 * module-level state from leaking between test cases.
 */
export function resetIceServerCache(): void {
  cache.clear();
  inFlight.clear();
}
