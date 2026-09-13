---
name: iPad recording background sharing
description: Why live-link sharing must happen before starting an iPad recording
---

Do not present native Live alerts, modals, the iOS share sheet, or Messages over an active iPad recording. Prepare and share the invite first, and only activate broadcasting after the coach returns. Pause the idle legacy Expo CameraView, but keep the shared native camera session active and let iOS interrupt it in place.

**Why:** Switching to Messages backgrounds StecStats, and even a native Live overlay can interrupt the active AVFoundation session. The result can be a stopped recording, a restored draft, or a scorekeeper that only offers Save Game. Physical testing showed two different failure modes: idle Expo CameraView can return black if left active, while explicitly stopping and restarting the shared native session can freeze its preview when the iPad rotates during sharing.

**How to apply:** Create the server invite without connecting the broadcaster, then connect only after sharing completes or the coach explicitly starts live after returning. Share-state deactivation applies only to legacy CameraView; never use it to stop the shared native session. Do not automatically remount either camera from a general AppState-active listener. Guard sharing with both the synchronous recording ref and rendered recording state. While recording, make Live controls non-modal and non-networking; show status inline. Keep the watch address and session code visible/selectable in-app.