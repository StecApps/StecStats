---
name: Expo Video segmented reel endings
description: Reliable handoff between standalone local MP4 clips on iOS.
---

For segmented iOS reel playback, do not rely exclusively on Expo Video's `playToEnd` event. Keep that listener, but also compare the server-validated clip duration during `timeUpdate` and when `playingChange` reports stopped. Trigger the same guarded advance exactly once.

**Why:** A production iPhone played a complete, independently validated 20-second MP4 to its final frame but remained on that clip. The stored clip and combined reel were complete; Expo Video did not reliably deliver the handoff event.

**How to apply:** Use a shared, idempotent advance path for `playToEnd`, the final `timeUpdate`, and a stopped player whose live `currentTime` is at the validated end. Reset the guard on source attachment and explicitly autoplay the next downloaded clip.