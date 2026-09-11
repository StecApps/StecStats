---
name: iOS camera always reports portrait dimensions
description: getUserMedia on iOS reports portrait videoWidth/videoHeight even in landscape; detectVideoRotation and video CSS must account for this.
---

## The Rule

On iOS Safari, `getUserMedia` always reports `videoWidth < videoHeight` (portrait sensor dimensions, e.g. 1080×1920) regardless of the physical device orientation. If you use those dimensions to set canvas size or `aspect-ratio` CSS, you get a portrait recording/display even though the user is in landscape.

**Why:** The iOS camera sensor is physically portrait. iOS feeds raw sensor pixels to the MediaStream API and adds rotation metadata separately. `ctx.drawImage(video, ...)` reads the raw (portrait) pixels — it does NOT apply rotation metadata.

**How to apply:**

1. **In `detectVideoRotation` (record.tsx):** Compare `videoIsLandscape` vs `deviceIsLandscape`. If device is landscape but video says portrait, read the angle to pick rotation direction — but NEVER mix `screen.orientation.angle` and `window.orientation` into a single normalized value. They have OPPOSITE conventions for landscape-left/-right:
   - `screen.orientation.angle` (iOS 16.4+): 90 = landscape-left → need -90°; 270 = landscape-right → need +90°
   - `window.orientation` (old iOS): -90 = landscape-left → need -90°; 90 = landscape-right → need +90°
   - Check which API is available and read its value directly — do not normalize and compare both.

2. **Pose/motion detection also runs on portrait pixels:** MediaPipe landmarks are in portrait normalized coords. In landscape mode, physical "up" = portrait x-axis. Arm-raise detection must check x-displacement (both ±) instead of y-displacement. See `detectShotPose` in playerTracking.ts.

3. **Never force `aspectRatio` CSS on `<video>` elements:** Pre-rotation `videoWidth/videoHeight` gives the wrong ratio on iOS. Remove `style={{ aspectRatio }}` and use `max-w-full max-h-[70vh]`.

4. **MediaRecorder mimeType:** iOS doesn't support `video/webm`. Add `video/mp4` as final fallback: `isTypeSupported("video/webm;codecs=vp9,opus") ? ... : isTypeSupported("video/webm") ? ... : "video/mp4"`.

5. **Expo CameraView on iPad:** Let the native camera follow physical device orientation and enable its responsive-orientation behavior. Do not expose a control that only changes the React layout orientation without changing native capture orientation.

**Why:** A layout-only portrait/landscape override can leave the preview and recorded rotation metadata out of sync, producing upside-down footage. Orientation churn can also leave native recording promises unsettled, so camera-switch waits must be bounded and reset their guards.
