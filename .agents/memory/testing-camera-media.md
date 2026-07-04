---
name: Testing camera/media features
description: How to verify features that use navigator.mediaDevices.getUserMedia (camera/mic recording) in this environment's Playwright-based test sandbox.
---

The Playwright-based `runTest` sandbox does not have a real or fake camera/microphone device attached. Calling `navigator.mediaDevices.getUserMedia({video: true, ...})` there will typically fail/reject, not silently succeed with a fake stream.

**Why:** No `--use-fake-device-for-media-stream` style flag or virtual camera is configured in the test browser, so any UI flow gated on a successful camera stream cannot be driven end-to-end through the UI alone.

**How to apply:** When building camera/mic-dependent features, always implement a graceful inline error path (not a crash) for when `getUserMedia` rejects, and treat that as expected/acceptable behavior in test plans. To verify the feature's data flow, prefer direct DB/API checks (e.g. confirm rows were created with correct fields) over relying on the E2E test to actually exercise the camera capture step.

## Attaching a MediaStream to a conditionally-rendered <video>
Setting `videoEl.srcObject = stream` synchronously inside the async `startRecording`
handler fails when the `<video>` only renders after `isRecording` becomes true — the
ref is still null at that point, so the stream never attaches and the preview is a
black screen. **Fix:** attach the stream in a `useEffect` keyed on the render-gating
state (e.g. `[isRecording, videoExpanded]`) so it runs after the element mounts.
