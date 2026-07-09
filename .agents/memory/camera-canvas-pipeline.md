---
name: Canvas camera pipeline (zoom + camera switch)
description: Why recording routes camera through a canvas instead of the raw MediaStream
---

# Canvas camera pipeline in record.tsx

Recording/streaming does NOT record the raw `getUserMedia` stream directly. It
draws the camera into an offscreen `<canvas>` (created imperatively, not in JSX)
via `requestAnimationFrame`, then records/streams `canvas.captureStream(30)` with
the mic audio track added into a combined output MediaStream (`streamRef`).

**Why:**
- **Digital zoom must work on iOS Safari.** The native `MediaStreamTrack`
  `zoom` constraint (`applyConstraints({advanced:[{zoom}]})`) is unsupported on
  iPhone browsers. Cropping a centered region in the canvas draw loop
  (`drawImage(v, sx, sy, sw, sh, 0,0, vw, vh)` with `sw=vw/zoom`) gives digital
  zoom that works everywhere.
- **Camera switch mid-recording without renegotiation.** Because MediaRecorder
  and WebRTC senders are bound to the *canvas* output track (a stable object),
  switching cameras only swaps the source video feeding the canvas — the output
  track never changes, so no MediaRecorder restart and no WebRTC renegotiation.
  Only the video input is re-requested (`audio:false`); the original mic track
  stays alive in the output stream.

**How to apply:**
- `zoomRef` mirrors `zoom` state so the rAF loop reads it without restarting.
- `rawStreamRef` = camera+mic from getUserMedia; `streamRef` = canvas output used
  by recorder/preview/peers. Cleanup must stop BOTH and `cancelAnimationFrame`.
- There's a fallback: if `HTMLCanvasElement.prototype.captureStream` is missing,
  record the raw stream directly and hide zoom/switch UI (`canSwitchCamera`).
- A hardware gimbal (e.g. DJI Osmo) cannot be integrated — its app/Bluetooth
  controls only talk to DJI's native app, not a browser. It only physically moves
  the phone; in-app zoom/switch is the substitute for its software features.

## Quality and field-of-view (wide angle)

- Browsers cannot zoom *out* past 1x digitally (the canvas crop only zooms in);
  wider field of view on multi-lens phones requires opening a different physical
  camera device via `getUserMedia({video:{deviceId:{exact}}})`, not a zoom constraint.
- `navigator.mediaDevices.enumerateDevices()` only returns usable labels (e.g.
  "Back Ultra Wide Camera") *after* permission has already been granted once, so
  the wide-lens auto-detect/enumeration must run after the first `getUserMedia`
  call, not before it.
- There is no reliable cross-browser API for "is this the back camera" beyond
  label heuristics (regex on `MediaDeviceInfo.label`, e.g. excluding
  `front|user|face|selfie`) — Android/iOS both vary in how many lenses they expose
  as separate devices and how they're labeled. Treat this as best-effort, not exact.
- Any place that (re)acquires the environment-facing stream (initial start, camera
  switch back to "environment") must re-run the lens enumeration/preference logic,
  and any teardown path must clear the resulting device-id list/flag — otherwise
  the "extra lens" UI option can go stale or persist after switching to selfie mode.
- **Portrait rotation bug**: `drawImage()` on an OFF-SCREEN `<video>` element
  reads raw sensor frames and IGNORES the rotation metadata that iOS/Android
  applies to visible `<video>` elements. Portrait phone → landscape sensor frames
  → canvas records sideways video. Fix: `detectVideoRotation(vw, vh)` compares
  `window.innerHeight > innerWidth` (device portrait) vs `videoWidth > videoHeight`
  (landscape frame). If mismatch, apply `-90` (or `+90` for upside-down portrait)
  via `screen.orientation.angle` / `window.orientation`. Canvas gets swapped
  dimensions (`vh × vw`), draw loop does `ctx.save/translate/rotate(angleRad)/
  drawImage(v, sx,sy,sw,sh, -vw/2,-vh/2, vw,vh)/ctx.restore`. The destination
  `(-vw/2,-vh/2,vw,vh)` fills the rotated canvas correctly at any zoom level.
  Recalculate rotation in `switchCamera` + `cycleLens` after new stream plays.
- **Preview black bars on tablet**: `<video class="w-full h-full object-cover">`
  inside a flex child doesn't always get a definite height. Fix: add
  `absolute inset-0` so the video always fills its `relative` container.
- "Fill the screen" vs "wide angle / cover more space" are in direct tension when the
  phone is held in portrait: a phone camera sensor is landscape (16:9). For sports
  recording, landscape orientation is the only way to get both.
- Generic control labels like "Lens" confuse users — surface the *active* lens
  (0.5×/1×/Tele derived from the device label) so a multi-lens button is
  self-explanatory. iOS device labels are only readable after permission is granted.
- **Camera flip can silently no-op on mobile:** requesting the new-facing stream
  BEFORE stopping the old one's tracks (request-then-stop) can make some mobile
  browsers refuse the second concurrent capture session, or silently hand back the
  same camera — looking like "the flip button does nothing" with no visible error.
  Fix: stop the previous stream's tracks FIRST, then request the new facingMode
  stream (stop-then-request). If the new request then fails, try to re-open the
  previous facingMode to avoid leaving the recording with a dead video source, and
  always surface the failure via a toast (a `cameraError` text in a packed camera
  overlay is easy to miss).
