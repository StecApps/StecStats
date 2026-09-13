---
name: iPad recording background sharing
description: Why live-link sharing must happen before starting an iPad recording
---

Do not present native Live alerts, modals, the iOS share sheet, or Messages over an active iPad CameraView recording. Prepare and share the invite first, pause the idle camera, and only activate broadcasting after the coach returns to StecStats.

**Why:** Switching to Messages backgrounds StecStats, and even a native Live overlay can interrupt the active AVFoundation session. The result can be a stopped recording, a restored draft, or a scorekeeper that only offers Save Game. Physical testing also showed that an idle Expo CameraView can return black and leave the scorekeeper in a portrait-sized layout after AirDrop or Messages. Attempts to add automatic foreground camera remounting and orientation recovery coincided with repeated Record Game entry terminations; removing only the orientation calls did not restore entry.

**How to apply:** Create the server invite without connecting the broadcaster, deactivate the idle CameraView before presenting Messages, and connect only after sharing completes or the coach explicitly starts live after returning. Do not automatically remount CameraView from a general AppState-active listener or add orientation control until that exact lifecycle has passed physical cold-entry and repeated-entry testing. Guard sharing with both the synchronous recording ref and rendered recording state, and ensure any share-state camera toggle can never deactivate the camera while either says recording is active. While recording, make Live controls non-modal and non-networking; show status inline. Keep the watch address and session code visible/selectable in-app.