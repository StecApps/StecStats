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
 */
export async function fetchIceServers(apiBase: string): Promise<RTCIceServer[]> {
  try {
    const res = await fetch(`${apiBase}/api/live/ice-servers`);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
        return data.iceServers as RTCIceServer[];
      }
    }
  } catch {
    // Network error — fall through to STUN fallback
  }
  return [{ urls: 'stun:stun.l.google.com:19302' }];
}
