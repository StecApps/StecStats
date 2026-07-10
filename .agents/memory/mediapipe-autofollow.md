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
- No person re-identification: doesn't use the player's reference photo yet (stored as `photoObjectPath`)
- Phase 3: use the reference photo to build a feature embedding and match the closest detected person

## Never auto-pan to "biggest detected person" before an explicit tap-to-lock
Early version picked the **largest** person bounding box to auto-pan/zoom the instant
Auto-Follow was toggled on, before the user tapped a specific player — on the theory
that "biggest = closest = the parent's own kid." In a real gym this is false at least
as often as it's true: spectators/other parents standing near the sideline camera are
frequently bigger in frame than the players on the court, so the camera would visibly
snap to the crowd instead of holding steady, which read as "auto-follow is just
grabbing crowd noise."

**Fix:** removed the pre-lock `detectPersonCenter` (biggest-bbox) call entirely —
`center` is `null` whenever `lockTargetRef` isn't set, so the camera now holds its
current framing and does nothing until the user taps their player. Position+colour
re-identification (`detectPersonNear`) only starts once that explicit tap has set the
lock. This matches the existing on-screen prompt ("Tap your player to lock focus"),
which was already telling the user to tap first — the pre-lock auto-pan was actively
contradicting its own UI copy.

**Why this over a smarter pre-lock heuristic:** "closest to frame center" or similar
was considered but rejected — no reliable signal distinguishes a parent standing
courtside-center from a player without an actual appearance model, and a *wrong*
guess is worse than *no* guess when the alternative (explicit tap) is already the
primary, always-on-screen call to action.

## Tap-to-lock re-identification is nearest-distance only — needs gating
`detectPersonNear(det, video, targetX, targetY)` (used once a player is locked) has no
appearance model — it just returns whichever detected person's bbox center is closest
to the last known spot, every frame. Without a max-distance cap this will happily
"lock onto" a different, merely-closer person the instant the real target is briefly
occluded/leaves frame, and the tracker silently drifts to the wrong player forever
(no false-positive signal, since it always finds *someone*).

**Fix applied:** added an optional `maxDist` param that rejects a match beyond a
plausible per-frame movement radius (returns null → counted as a miss → existing
home-view fallback kicks in after `MISS_THRESHOLD`). Radius grows a little with each
consecutive miss (re-acquire nearby after occlusion) but resets on every hit — this
is a re-acquisition radius, not a hard cap, so tune `SEARCH_RADIUS_BASE`/`_MAX` in
record.tsx's detection interval if it feels too sticky or too jumpy.

Also add short hysteresis (2 consecutive misses, not 1) before flipping the UI to
"Searching…" — the object detector naturally drops single frames, so 1-frame-miss-
driven UI state flickers between "Tracking"/"Searching" even when lock is fine.

True appearance-based re-ID (jersey number OCR, jersey color) was evaluated and
deferred: OCR on phone-quality/motion-blurred video at typical shooting distance is
unlikely to be reliably accurate; jersey-color matching is more tractable if revisited
(sample average pixel color in the bbox from the source video via an offscreen canvas).

## Two concurrent GPU-delegate MediaPipe tasks silently break the second one
Auto-follow's `ObjectDetector` and shot detection's `PoseLandmarker` both call
`detectForVideo()` on the same `<video>` element from separate `setInterval`s
(333ms / 1000ms). When BOTH used `delegate: "GPU"`, once auto-follow tracking
became reliable enough to run continuously, shot detection stopped firing
entirely — with no thrown/visible error, because the failure was caught and
swallowed silently. Two GPU-delegated tasks-vision models contending for the
same WebGL context is the suspected cause. Fix: give the less latency-sensitive
task (`PoseLandmarker`, sampled once/second) `delegate: "CPU"` instead, leaving
`ObjectDetector` (sampled 3x/second, needs to be fast) on GPU. If adding a THIRD
concurrent vision task later, keep at most one of them on GPU.
Also: never let a `detectForVideo` catch block swallow silently — log
`console.error` even though the UI shouldn't surface every dropped frame, or a
real regression like this one is undiagnosable from a user's screenshot alone.

## Position-only re-ID isn't enough when players are close together
`detectPersonNear` originally picked whichever detected person was nearest the
last known lock position. With several similar-sized players clustered near
each other (e.g. a scrum, or teammates standing close), this let the lock jump
onto the wrong player whenever she momentarily became "nearest" — a real
problem when the object detector only gives person bounding boxes, no
identity. Added a jersey/torso colour signature: on tap-to-lock, sample the
average colour of the middle-upper ~40% of the bbox (avoids hair/face/shorts
and edge background bleed); keep a running EMA-blended `lockColorRef`; when
`detectPersonNear` finds multiple plausible candidates within the search
radius, score them by `positionDistance + colorDistance*1.2` instead of
position alone. This helps most when the target's jersey colour differs from
nearby players (e.g. opposing team) — it will NOT disambiguate teammates in
identical uniforms, since colour alone can't tell them apart in that case.

## Model downloads need a client-side timeout on unreliable networks
`getObjectDetector()`/`getPoseLandmarker()` await `FilesetResolver`/model
`createFromOptions` fetches with no timeout. On a flaky/captive-portal
network (e.g. airport wifi) a stalled fetch can hang forever with no thrown
error, leaving the UI stuck on "Loading…" indefinitely (Auto-Follow button)
with no way to retry. Fixed by racing both loaders against a 20s timeout
(`withTimeout` helper in playerTracking.ts) so a stalled load rejects and
existing catch blocks (toast + reset for auto-follow) can run. Any future
network-dependent model/asset load in this app should go through the same
pattern rather than a bare `await`.

## Search radius: prefer losing lock over jumping to the wrong player
After adding colour re-ID, user feedback was still "prefer a tighter radius
that won't jump to a farther-away player" over recovering faster from misses.
Tightened `SEARCH_RADIUS_BASE`/`_MAX`/per-miss growth in record.tsx's
detection interval (from 0.16/0.5/0.05 down to 0.1/0.3/0.03) — this trades
away some re-acquisition speed after a real occlusion in exchange for making
an incorrect jump much less likely. If re-acquisition ever feels too
trigger-happy dropping to "Searching…"/home-view, these are the first knobs
to loosen back up (see `MISS_THRESHOLD` for when it gives up and recenters).
