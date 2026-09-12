---
name: iPad recording background sharing
description: Why live-link sharing must happen before starting an iPad recording
---

Do not present native Live alerts, modals, the iOS share sheet, or Messages over an active iPad CameraView recording. Prepare and share the invite first, pause the idle camera, and only activate broadcasting after the coach returns to StecStats.

**Why:** Switching to Messages backgrounds StecStats, and even a native Live overlay can interrupt the active AVFoundation session. The result can be a stopped recording, a restored draft, or a scorekeeper that only offers Save Game.

**How to apply:** Create the server invite without connecting the broadcaster, deactivate the idle CameraView before presenting Messages, and connect only after sharing completes or the coach explicitly starts live after returning. Guard sharing with both the synchronous recording ref and rendered recording state, and ensure any share-state camera toggle can never deactivate the camera while either says recording is active. While recording, make Live controls non-modal and non-networking; show status inline. Keep the watch address and session code visible/selectable in-app.