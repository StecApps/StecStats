---
name: Expo Video segmented reel endings
description: Reliable handoff between standalone local MP4 clips on iOS.
---

For segmented iOS reel playback, do not rely exclusively on Expo Video's `playToEnd` event. Keep that listener, but also use the server-validated clip duration with a narrow end tolerance to trigger the same guarded advance exactly once.

**Why:** A production iPhone played a complete, independently validated 20-second MP4 to its final frame but remained on that clip. The stored clip and combined reel were complete; Expo Video did not reliably deliver the handoff event.

**How to apply:** Use a shared, idempotent advance path for both `playToEnd` and the final `timeUpdate`. Reset its end guard whenever a new source is attached, and preserve explicit autoplay for the next downloaded clip.