---
name: Live streaming via custom WebRTC signaling
description: How invitation-only real-time live streaming was built for hoops-stats without a third-party media/SFU service.
---

Live streaming (coach broadcasts, invited viewers watch in real time via a private link/code, no accounts) is implemented with a custom WebRTC signaling relay on api-server, not a third-party service.

**Why:** No suitable WebRTC/SFU/livestream integration was available in this environment's integrations catalog at the time. A lightweight signaling relay (star topology: one `RTCPeerConnection` per viewer on the broadcaster side) avoids adding an external dependency for what is a low-viewer-count, ephemeral use case.

**How to apply:**
- Signaling runs over a `ws` WebSocket server attached via the HTTP server's `upgrade` event (not a separate port), at a path under the existing `/api` convention.
- Sessions (broadcaster/viewer socket refs, invite code, metadata) are kept **in-memory only** on api-server — not persisted to the DB — since they're ephemeral and decoupled from any specific DB row (e.g. no need to pre-create a game before going live).
- STUN-only (`stun:stun.l.google.com:19302`), no TURN — will fail for viewers/broadcasters behind restrictive NATs/firewalls. If that becomes a real problem, a TURN service would need to be added.
- If extending this (recording the live stream, persisting chat, viewer auth, etc.), keep the in-memory/ephemeral design in mind — it does not survive an api-server restart.
