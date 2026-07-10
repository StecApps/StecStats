---
name: Live-stream viewer orientation mismatch
description: Why a live-stream video can look "shrunk" with the overlay covering it, and how the watch page tells viewers which way to rotate.
---

The broadcast video's shape (portrait or landscape) is locked to whatever
orientation the *broadcaster's* phone/tablet was in at the moment they hit
Record (see `camera-canvas-pipeline.md`). A *viewer's* own phone orientation
has nothing to do with that — it's just the shape of their viewport.

When the two don't match (e.g. a portrait broadcast viewed on a phone held
landscape), `object-contain` pillarboxes the video down to a thin strip that
fills the full height/width of the opposite axis. Because the video then
touches the container edge on the axis it fills, a top-pinned overlay (e.g.
the scoreboard bar) reads as if it's "sitting right on the frame" even though
its position didn't change — it's just proportionally much more of the now-tiny
visible video.

**Fix applied:** `watch.tsx` reads the incoming WebRTC video track's real
`videoWidth`/`videoHeight` via `onLoadedMetadata` (no rotation-detection quirk
needed here — unlike the broadcaster's raw camera feed, this stream is already
a canvas-composited output, so the dimensions it reports are the true final
pixel shape) and compares it to the viewer's live `matchMedia("(orientation:
portrait)")` state. On mismatch it shows a dismissible "turn your phone to
___ to see the full video" tip.

**Why:** Two separate `matchMedia` queries are required — one for real screen
orientation, one for `(pointer: coarse)` — and must NOT be combined into a
single query like the record-page rotate tip does. The record page's combined
query is intentional there because that tip only ever needs to fire on a touch
device. But on the watch page, blindly gating orientation itself on
`pointer:coarse` makes the query permanently read "not portrast" on desktop,
producing a false mismatch that tells desktop viewers (no phone to rotate) to
"turn your phone" forever. Gate the *tip visibility* on touch, but compute
orientation truthfully regardless of pointer type.

**How to apply:** Any future "please rotate" UX on a page that both touch and
non-touch users can land on needs this same two-query split.
