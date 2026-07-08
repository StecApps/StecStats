---
name: iOS camera always reports portrait dimensions
description: getUserMedia on iOS reports portrait videoWidth/videoHeight even in landscape; detectVideoRotation and video CSS must account for this.
---

## The Rule

On iOS Safari, `getUserMedia` always reports `videoWidth < videoHeight` (portrait sensor dimensions, e.g. 1080×1920) regardless of the physical device orientation. If you use those dimensions to set canvas size or `aspect-ratio` CSS, you get a portrait recording/display even though the user is in landscape.

**Why:** The iOS camera sensor is physically portrait. iOS feeds raw sensor pixels to the MediaStream API and adds rotation metadata separately. `ctx.drawImage(video, ...)` reads the raw (portrait) pixels — it does NOT apply rotation metadata.

**How to apply:**

1. **In `detectVideoRotation` (record.tsx):** Compare `videoIsLandscape` (from `videoWidth > videoHeight`) vs `deviceIsLandscape` (from `window.innerWidth > window.innerHeight`). If they differ and the device is landscape (but video says portrait), use `screen.orientation.angle` to pick ±90° rotation. Landscape-left (angle≈90) → -90°; landscape-right (angle≈270) → +90°.

2. **Never force `aspectRatio` CSS on `<video>` elements:** Pre-rotation `videoWidth/videoHeight` gives the wrong aspect ratio on iOS. Remove `style={{ aspectRatio }}` and let the browser size the video at its natural display dimensions (`max-w-full max-h-[70vh]` is sufficient).

3. **MediaRecorder mimeType:** iOS doesn't support `video/webm`. Add `video/mp4` as final fallback: `isTypeSupported("video/webm;codecs=vp9,opus") ? ... : isTypeSupported("video/webm") ? ... : "video/mp4"`.
