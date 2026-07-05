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

**Out-of-band metadata (e.g. live scoreboard) rides the signaling websocket, not a data channel:**
- To push non-media data (live score) broadcaster→viewers, add a message type to the same `ws` signaling relay rather than opening a WebRTC data channel. Store the latest value on the in-memory `LiveSession` so late-joining viewers can be sent the current value on join, and also expose it on the REST `/status` endpoint so the viewer page shows it before the ws even connects.
- Gate writes by role on the server (`if (role !== "broadcaster") break;`) — viewers share the same socket protocol and must not be able to mutate shared session state.

**Viewer page must be full-viewport, not a card:** the watch page video should be `fixed inset-0` full-bleed with `object-contain`, not wrapped in a centered `max-w-*` + `aspect-video` card — on a portrait phone that card collapses to a tiny letterboxed strip. Full-viewport fills the whole screen in landscape and the full width in portrait while keeping the entire game frame visible. Position overlays with `env(safe-area-inset-*)` for notched phones.

**Record-page overlay split must reserve panel height on mobile:** the fullscreen recording overlay splits video vs the scrollable controls panel via flex ratios. A large video ratio (e.g. flex-[3] vs flex-1) is fine on tablets but on phones the sticky scoreboard HUD eats the whole small panel and hides the per-player MAKE/MISS cards. Give the panel more height on mobile (flex-[2] md:flex-1) and keep the scoreboard HUD compact (horizontal ScoreControl, not a tall stacked block).

**Muting the recorder's own mic:** flip the raw stream's audio track `.enabled` (not a separate mute state on the recorder). Because the same audio track object is added to both the MediaRecorder output and each viewer `RTCPeerConnection`, toggling `.enabled` mutes recording and live audio together — which is the desired behavior.
