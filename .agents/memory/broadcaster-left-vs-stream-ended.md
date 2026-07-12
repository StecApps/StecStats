---
name: broadcaster-left vs stream-ended are different signals
description: The two server→viewer WebSocket messages that end a live stream mean different things and must be handled differently on the viewer side.
---

`broadcaster-left` — sent by `liveSocket.ts` `ws.on("close")` when the **broadcaster's WebSocket closes unexpectedly** (network drop, phone background, api-server restart). The broadcaster's recording app is still running and will reconnect.

`stream-ended` — sent by `liveStream.ts` `endSession()` when the **coach explicitly taps "Stop Stream"** (`POST /live/:code/stop`). The session is marked inactive in the DB and will not resume.

**Why this matters:** `broadcaster-left` is a transient network event. If the viewer treats it as "stream over" (sets `explicitEndRef = true`, goes to "ended" state), they are permanently locked out even though the broadcaster comes back in seconds. This was the root cause of "everyone gets kicked out" during a streaming session — any brief network hiccup on the coach's phone kicked all viewers to the final-score screen with no way back.

**How to apply:**
- On `broadcaster-left`: close the stale `RTCPeerConnection`, transition to `waiting-for-broadcaster`, keep the viewer's signaling WebSocket alive. Do NOT set `explicitEndRef.current = true`. The stream auto-resumes when the broadcaster reconnects and sends `join-broadcaster` → server sends `new-viewer` to each waiting viewer → broadcaster offers again.
- On `stream-ended`: set `explicitEndRef.current = true`, show final-score summary, go to "ended". This is the only true terminal event.
- The server correctly never sends `broadcaster-left` from `endSession()` (the session is deleted from memory before the WS close handler runs, so `getSession()` returns undefined there). The differentiation is reliable at the source.
