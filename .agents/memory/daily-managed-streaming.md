---
name: Daily managed streaming
description: Why StecStats Live uses Daily cloud recording and the durability/security rules that must remain intact.
---

StecStats Live uses Daily as the sole camera owner on mobile. The iPad publishes through Daily, Daily records the authoritative cloud master, and Daily sends one RTMPS output to an unlisted YouTube Live broadcast. Public viewers watch the YouTube embed through the account-free StecStats share link; they must not receive Daily meeting tokens for new sessions. The API imports the finalized Daily master into App Storage before generating reels. Do not reintroduce simultaneous HoopsCamera recording, custom WebRTC/MJPEG publishing, or per-viewer Daily delivery during a Daily session. Daily's call object is headless: the scoring screen must render its local participant video track through `DailyMediaView`; disabling HoopsCamera alone otherwise leaves a black preview even while capture is active.

**Why:** The custom simultaneous local-recording and livestream paths repeatedly failed on physical iPads. Managed cloud recording removes competing camera ownership, while one RTMP output prevents viewer count from multiplying Daily participant-minute costs.

**How to apply:** Persist the live-session-to-game association in the same durable game-save operation, including offline retries. Keep broadcaster signaling authenticated and session-bound. Render only Daily's local track while a Daily session is active. Delay public scores/stats through a durable DB queue to match YouTube latency, and keep YouTube start/finalization retryable and fenced. Use renewable token-fenced leases for long recording imports.