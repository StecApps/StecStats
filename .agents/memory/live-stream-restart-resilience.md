---
name: Live stream restart resilience
description: How the hoops-stats live broadcast survives an api-server restart mid-game — persisted session codes plus client-side auto-reconnect.
---

An api-server restart wipes all in-memory WebSocket/RTCPeerConnection state, but should not permanently kill an in-progress live broadcast or invalidate its invite code.

**Design:**
- Session metadata (code, opponent, teamName, active) is persisted to a `live_sessions` table on session create/end. On any lookup miss (WS join, `/live/:code/status`), `getOrResumeSession()` falls back to the DB row and recreates the in-memory session shell, so a pre-restart code keeps working.
- Both broadcaster (`record.tsx`) and viewer (`watch.tsx`) clients auto-reconnect their signaling WebSocket with exponential backoff (capped attempts) on an unexpected `onclose`, distinguished from a deliberate stop via a ref flag (`manualStop` / `explicitEnd`) so intentional "end stream" actions don't trigger a reconnect loop.
- Broadcaster keeps the local camera/MediaRecorder running through a signaling drop — only the live broadcast, not the recording, is affected. It clears stale peer connections and waits for fresh `new-viewer` events after reconnecting, since the server's per-session viewer list resets on resume.
- Viewer re-checks `/live/:code/status` right after a successful reconnect (rather than assuming state) because the broadcaster may reconnect on a different timeline.
- UI shows a distinct "reconnecting" state throughout retries, and only falls back to a clear "stream interrupted" message once retries are exhausted — satisfying both "auto-resume" and "clear failure messaging" as complementary, not either/or.

**Why:** silently going blank (old behavior) left the coach with no way to know if streaming had failed or resume it; simply persisting the DB row without client reconnect logic would still show viewers "stream not found" since their WebSocket also died with the server.

**How to apply:** if adding more live-session fields, persist and resume them the same way, or resumed sessions will look incomplete/wrong after a restart.
