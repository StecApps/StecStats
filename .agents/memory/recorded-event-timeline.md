---
name: Recorded-event timeline
description: Why reel tags must use a recording-segment clock rather than the game clock.
---

Events used for Highlights and Lowlights must be timestamped against the final saved movie. Advance the timestamp only while a camera segment is actively recording, and preserve the accumulated duration across segment switches.

**Why:** The game clock can start before the camera, keep wall-clock time across pauses, and include camera finalization or switch gaps that are removed when segments are concatenated. Those timestamps can land beyond the saved video and make valid tagged plays impossible to render.

**How to apply:** Any recording start, stop, pause, resume, or camera-switch path must update the recording timeline at the same boundary used to create the saved segments. Do not derive reel timestamps from the scoreboard clock.