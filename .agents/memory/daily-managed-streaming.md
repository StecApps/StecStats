---
name: Daily managed streaming
description: Why StecStats Live uses Daily cloud recording and the durability/security rules that must remain intact.
---

StecStats Live uses Daily as the sole camera owner on mobile. The iPad publishes through Daily, Daily records in the cloud, browser viewers join with receive-only tokens, and the API imports the finalized master into App Storage before generating reels. Do not reintroduce simultaneous HoopsCamera recording or custom WebRTC/MJPEG publishing during a Daily session.

**Why:** The custom simultaneous local-recording and livestream paths repeatedly failed on physical iPads. Managed cloud recording removes the competing camera ownership and provides one authoritative master.

**How to apply:** Persist the live-session-to-game association in the same durable game-save operation, including offline retries. Keep broadcaster signaling authenticated and session-bound, keep viewer media permissions receive-only, and use renewable token-fenced leases for long recording imports.