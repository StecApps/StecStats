---
name: MediaPipe auto-follow in draw loop
description: How the player auto-follow tracking is integrated into the canvas recording pipeline without blocking the 30fps draw loop
---

## Rule
Run MediaPipe ObjectDetector on a `setInterval` at ~3fps (333ms), never inside the `requestAnimationFrame` draw loop. Feed the detected center into the draw loop via refs.

**Why:** `detectForVideo` is synchronous and takes 10–30ms per call. Calling it inside the 30fps rAF loop would drop every frame to ~30ms (≈33fps max becomes ~15fps effective). Decoupling to a 333ms interval keeps the rAF loop free and adds ≤3% CPU overhead.

## Architecture

```
setInterval(333ms) → detectPersonCenter(det, sourceVideoRef) 
  → EMA smooth → trackCenterX/YRef.current (shared refs)

requestAnimationFrame (30fps) → reads trackCenterX/YRef.current
  → computes cx/cy crop offset → drawImage(v, sx, sy, sw, sh, ...)
```

### Key refs
- `autoFollowRef` — mirrors `autoFollowEnabled` state so the rAF loop reads it synchronously without closure staleness
- `trackCenterXRef / trackCenterYRef` — normalized 0-1 center of detected person; initialized to 0.5/0.5 (frame center)
- `objectDetectorRef` — holds the singleton ObjectDetector instance after lazy load

### EMA smoothing (α=0.2)
```
centerX = 0.8 * centerX + 0.2 * detectedX
```
This gives ~5-frame lag (≈1.7 seconds at 3fps) for smooth pan rather than jittery jumps.

### Crop offset calculation
```js
const cx = autoFollowRef.current ? trackCenterXRef.current : 0.5;
const cy = autoFollowRef.current ? trackCenterYRef.current : 0.5;
const sx = Math.max(0, Math.min(vw - sw, cx * vw - sw / 2));
const sy = Math.max(0, Math.min(vh - sh, cy * vh - sh / 2));
```
At zoom=1, sw=vw so sx=0 always — auto-follow is a no-op until zoomed. This is why `toggleAutoFollow` auto-bumps zoom to 1.5× if currently at 1×.

## Model loading
- Uses `@mediapipe/tasks-vision` EfficientDet-Lite0 model (~4MB) from `storage.googleapis.com/mediapipe-models/...`
- WASM binary from `cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm`
- Singleton pattern: `getObjectDetector()` caches the instance; subsequent calls return the cached instance immediately
- Errors during load show a toast; tracking is not enabled on failure

## Cleanup
`stopMediaPipeline()` must clear:
1. `clearInterval(detectionIntervalRef.current)`
2. `autoFollowRef.current = false`
3. `setAutoFollowEnabled(false)`, `setIsTracking(false)`
4. Reset `trackCenterX/YRef.current` to 0.5

The detection interval useEffect also cleans up on `[autoFollowEnabled, isRecording]` dependency change.

## UI
- Auto-Follow button appears in camera overlay top-right (alongside Lens/Switch/Zoom), gated behind `isPremium`
- States: "Auto-Follow" (off) → "Loading…" (model downloading) → "Searching…" (enabled, no detection) → "Tracking" (enabled + person found, crosshair pulses)
- Enabling at zoom=1 auto-bumps to 1.5×

## Limitations / Phase 3 notes
- Picks the **largest** person bounding box — assumes the parent is aiming at their player (most of frame)
- No person re-identification: doesn't use the player's reference photo yet (stored as `photoObjectPath`)
- Phase 3: use the reference photo to build a feature embedding and match the closest detected person
