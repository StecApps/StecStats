---
name: Pose-based auto shot-detection heuristic (hoops-stats)
description: Why the raised-arm shot-detection heuristic produced false positives, and the two guards that fixed it.
---

`detectShotPose` (in `playerTracking.ts`) uses MediaPipe `PoseLandmarker` and a
purely geometric heuristic — "is the wrist clearly above/past the shoulder
along the device's assumed physical up-axis" — to guess when a shot was
attempted. Real-world use surfaced two distinct false-positive modes, both
fixed without touching the core geometry:

**1. Camera pointed at a non-person (panned away mid-recording, e.g. via
auto-follow losing the subject).** The lite pose model still returns 33
landmarks even on furniture/background clutter — overall pose *presence*
confidence (default threshold 0.5 in `PoseLandmarkerOptions`) can pass on a
vaguely person-shaped blob while individual joints are still near-zero
confidence. The per-landmark `visibility` field (0-1, present on every
`NormalizedLandmark`) was never being checked. Fix: reject the frame if any of
the 8 landmarks used (shoulders, elbows, wrists, hips) has `visibility` below
~0.6, before evaluating the raise geometry at all.

**2. Subject lying down / reclining (e.g. a kid resting in bed).** The raise
check assumes an upright body, so "wrist y-coordinate above shoulder
y-coordinate" only means "arm raised relative to the body" when the body's own
up-axis roughly matches the device's physical up-axis. Lying down breaks that
assumption entirely — ordinary resting arm positions near the head can satisfy
the raw-coordinate check even though nothing shot-like happened, and since
static poses re-trigger every time the shot-detection cooldown (4.5s) expires,
this repeats indefinitely rather than firing once. Fix: compute the
hip-midpoint -> shoulder-midpoint vector and require it to be reasonably
aligned (dot product with the assumed up-axis unit vector, threshold ~0.5,
i.e. torso within ~60° of upright) before trusting the raise geometry. This
needed hip landmarks (indices 23/24), which weren't previously read at all.

**General lesson:** a single-frame geometric pose heuristic needs both a
*confidence* gate (per-landmark visibility, not just overall pose presence)
and a *plausibility* gate (does the body's overall orientation match what the
geometry assumes) — checking only the two joints directly involved in the
gesture (wrist/shoulder) is not enough; a person's actual pose relative to the
frame can invalidate the whole coordinate scheme the heuristic depends on.
