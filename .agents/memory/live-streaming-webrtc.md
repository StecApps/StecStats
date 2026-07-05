---
name: Live streaming via custom WebRTC signaling
description: How invitation-only real-time live streaming was built for hoops-stats without a third-party media/SFU service.
---

Live streaming (coach broadcasts, invited viewers watch in real time via a private link/code, no accounts) is implemented with a custom WebRTC signaling relay on api-server, not a third-party service.

**Why:** No suitable WebRTC/SFU/livestream integration was available in this environment's integrations catalog at the time. A lightweight signaling relay (star topology: one `RTCPeerConnection` per viewer on the broadcaster side) avoids adding an external dependency for what is a low-viewer-count, ephemeral use case.

**How to apply:**
- Signaling runs over a `ws` WebSocket server attached via the HTTP server's `upgrade` event (not a separate port), at a path under the existing `/api` convention.
- Sessions (broadcaster/viewer socket refs, invite code, metadata) are kept **in-memory only** on api-server — not persisted to the DB — since they're ephemeral and decoupled from any specific DB row (e.g. no need to pre-create a game before going live).
- TURN relay added via Metered.ca: api-server exposes `GET /api/live/ice-servers` which calls Metered's `turn/credentials` REST API server-side (caching ~30min) and falls back to STUN-only if `METERED_API_KEY`/`METERED_DOMAIN` are unset or the call fails. Frontend fetches this endpoint (instead of a hardcoded ICE server constant) before creating each `RTCPeerConnection`, on both broadcaster and viewer sides.
- If extending this (recording the live stream, persisting chat, viewer auth, etc.), keep the in-memory/ephemeral design in mind — it does not survive an api-server restart.

**Viewer black-screen gotchas (two independent causes, both must be handled):**
- Do NOT conditionally render the viewer `<video>` only when a "live" state is true. `pc.ontrack` fires *before* the React state commit, so `videoRef.current` is null at attach time and the remote stream is silently dropped. Always keep the `<video>` mounted (hide with a class), stash the stream in a ref, and attach it both inside `ontrack` and again in a `useEffect` keyed on the live state.
- The viewer video MUST start `muted` — the broadcast carries an audio track, and mobile browsers block autoplay of unmuted media without a user gesture, producing a black screen even though the track is flowing. The broadcaster's own preview works only because it's muted. Provide an explicit "tap for sound" control that sets `video.muted=false` and replays on the user gesture.
