---
name: iPad recording background sharing
description: Why live-link sharing must happen before starting an iPad recording
---

Do not open the iOS share sheet or Messages while an iPad camera recording or live broadcaster connection is active. Prepare the invite first, pause the idle camera, send the link, and only activate broadcasting after the coach returns to StecStats.

**Why:** Switching to Messages backgrounds StecStats. iPadOS suspends the camera and can also interrupt the live socket/native media stack, leaving the scorekeeper stopped, restored from draft, or unreliable even if recording had not started.

**How to apply:** Create the server invite without connecting the broadcaster, deactivate the idle CameraView before presenting Messages, and connect only after sharing completes or the coach explicitly starts live after returning. Block sharing while recording. Keep the watch address and session code visible/selectable in-app.