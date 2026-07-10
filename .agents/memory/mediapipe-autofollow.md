---
name: MediaPipe auto-follow in draw loop
description: How the player auto-follow tracking is integrated into the canvas recording pipeline — decoupled 3fps predictive tracker + 60fps draw-loop-owned visual smoothing
---

## Architecture (current, post redesign)
Two clocks, two responsibilities, connected only through `desired*Ref` handoff refs:

```
setInterval(333ms) → updateTracker(det, video, trackerState, dt)   [IDENTITY/MOTION]
  → predicts next position from velocity, gates candidates tightly against the
    PREDICTION (not last observation), height-consistency-gates, uses colour only
    as a tie-breaker, requires an ambiguity margin over 2nd-best candidate,
    coasts on decaying velocity through misses instead of widening search radius
  → writes desiredXRef / desiredYRef / desiredZoomRef ONLY

requestAnimationFrame (~60fps, inside startDrawLoop's draw()) → [VISUAL SMOOTHING]
  → dt-based exponential ease (time-constant, not fixed alpha) of
    trackCenterX/YRef / trackZoomRef toward desired*Ref, with a dead zone
    (ignore sub-jitter movement) and a slew-rate clamp (bounded max pixels/sec
    regardless of how big the jump in desired* was)
  → trackCenterX/YRef / trackZoomRef are what's actually read for the crop math
```

**Why split this way:** the old design let the 3fps detection tick write
`trackCenterXRef`/`trackZoomRef` (the actually-drawn position) directly via a
reactive alpha-blend that boosted itself from positional error. A single noisy
or ambiguous detection sample could snap the visible camera immediately —
every fix to the *identification* logic (radius, colour, hysteresis) still
rode on a pan/zoom mechanism that could jump on one bad sample. Decoupling
means the draw loop is the ONLY place visible motion is produced, so identity
mistakes are structurally capped at a small nudge, not a snap, and the
identity tracker can be tuned independently of how the camera physically moves.

### Key refs
- `trackerStateRef` — `TrackerState` (position, velocity, colour signature, miss count) owned by `updateTracker`; `null` until a tap-to-lock creates it, `null` again on toggle-off
- `desiredX/Y/ZoomRef` — latest target from the identity tracker; written only by the detection tick (and the lost→home-pan fallback)
- `trackCenterX/YRef` / `trackZoomRef` — the actually-drawn/cropped position; written only by the draw loop's easing step (plus tap-to-lock's immediate snap and reset paths)
- `lastTickTimeRef` / `lastDrawTimeRef` — per-loop previous-timestamp refs so both the tick and the draw step compute a real `dt` instead of assuming a fixed frame time
- `lostSinceRef` / `lockLost` state — set when the tracker's coast budget (`TRACK_MAX_COAST_TICKS`) is exhausted; holds current framing and shows a "Lost lock — tap to re-lock" prompt, only pans home after `LOST_HOME_DELAY_MS` (5s) of no re-lock tap

### Identity tracker (`updateTracker` in playerTracking.ts)
- Gates new candidates against the **predicted** position (`state + velocity*dt`), not the last raw observation — lets a genuinely sprinting player stay findable with a *tight* radius instead of needing an ever-growing one (which was the old design's core flaw: a wide-enough radius to catch a sprint was also wide enough to grab a different nearby player).
- Height-consistency gate rejects a same-spot candidate whose bbox height changed implausibly (~35%) between ticks — usually a different/partial person.
- Colour is a tie-breaker weight (0.5), never the primary signal — 8x8 downsampled RGB from a 3fps sample can't reliably separate teammates in matching jerseys on its own.
- Ambiguity margin: if best and second-best candidate scores are too close, treat the tick as a miss rather than guess.
- On miss: coast up to `TRACK_MAX_COAST_TICKS` (4 ticks ≈1.3s) on decaying predicted velocity before reporting `lost: true` — never re-expands the acceptance radius to "find someone."
- Colour signature is only blended in when the matched candidate's colour is within a sanity ceiling (`TRACK_COLOR_SANITY_MAX`) of the running signature, so one bad-lighting frame can't permanently corrupt future re-identification.

### Crop offset calculation (unchanged math, now fed by eased refs)
```js
const cx = autoFollowRef.current ? trackCenterXRef.current : 0.5;
const cy = autoFollowRef.current ? trackCenterYRef.current : 0.5;
const sx = Math.max(0, Math.min(vw - sw, cx * vw - sw / 2));
const sy = Math.max(0, Math.min(vh - sh, cy * vh - sh / 2));
```
At zoom=1, sw=vw so sx=0 always — auto-follow is a no-op until zoomed. `toggleAutoFollow` auto-bumps zoom to 1.5× if currently at 1×.

## Model loading
- `@mediapipe/tasks-vision` EfficientDet-Lite0 (ObjectDetector, GPU delegate, 3fps) + PoseLandmarker-lite (shot detection, CPU delegate, 1fps) — **never both on GPU**: two concurrent GPU-delegated tasks-vision models contend for the same WebGL context and one silently stops firing `detectForVideo` with no thrown error. If adding a third concurrent vision task, keep at most one on GPU.
- `getObjectDetector()`/`getPoseLandmarker()` singletons, each raced against a 20s timeout (`withTimeout` helper) — unreliable networks (captive portal wifi) can hang a model-load fetch forever with no error, which otherwise sticks the UI on "Loading…" forever.
- Never let a `detectForVideo` catch block swallow silently — always `console.error`, or a real regression is undiagnosable from a user's screenshot alone.

## UI states
- Auto-Follow button: "Auto-Follow" (off) → "Loading…" (model downloading) → "Searching…" (enabled, no lock/detection) → "Tracking" (locked + tracker matching) → gated behind `isPremium`
- Overlay ring: pulsing "Locked" while tracking; dimmed static ring + "Lost lock — tap to re-lock" once the coast budget is exhausted; "Tap your player to lock focus" prompt before any tap has ever locked

## Never auto-pan to "biggest detected person" before an explicit tap-to-lock
No pre-lock auto-pan exists — the tracker (`trackerStateRef`) is only created by `handlePreviewTap`. Before that, `desired*Ref` never changes, so the camera holds its current framing. This is deliberate: "biggest bbox" in a gym is as likely to be a parent standing courtside as the player on court, and a wrong auto-guess is worse than requiring the explicit tap the UI already prompts for.

## Cleanup contract
`stopMediaPipeline()` / `toggleAutoFollow` (disable branch) must reset: `trackerStateRef` → `null`, `lostSinceRef` → `null`, `lockLost` → `false`, `desiredX/Y/ZoomRef` → `0.5/0.5/1`, `trackCenterX/YRef`/`trackZoomRef` → `0.5/0.5/1`, plus the usual `autoFollowRef`/`autoFollowEnabled`/`isTracking`/`lockedDisplayTarget` state. Missing any of these leaves stale state that corrupts the next tap-to-lock or briefly flashes the old framing.
