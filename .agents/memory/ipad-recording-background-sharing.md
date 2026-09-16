---
name: iPad recording background sharing
description: Why live-link sharing must happen before starting an iPad recording
---

Do not present native Live alerts, modals, the iOS share sheet, or Messages over an active iPad recording. Prepare and share the invite first, and only activate broadcasting after the coach returns. Before opening Messages, explicitly stop even the shared native AVCaptureSession and await native confirmation. After return, wait for UIApplication to become active, allow orientation to settle, restart capture, and await native confirmation before activating WebRTC or unlocking recording.

**Why:** Switching to Messages backgrounds StecStats and rotates the iPad. Physical testing showed that leaving the shared session active produced score-only livestreaming plus a single short playable recording. Immediate restart can also freeze, because Share completion does not guarantee the app is active or orientation has settled.

**How to apply:** Create the server invite without connecting the broadcaster. Use native suspend/resume acknowledgements with bounded timeouts. Route resume through the foreground/orientation gate. Keep a synchronous sharing/recovery guard across every recording entry point; activate live before releasing it. A failed recovery must remain loud and block recording until restart. While recording, keep Live controls non-modal and show status inline.