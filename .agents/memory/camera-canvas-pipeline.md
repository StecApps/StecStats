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
