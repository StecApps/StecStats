---
name: Recording-confirmed game clock
description: Physical-device invariant that prevents game time and tagged plays from getting ahead of saved film.
---

For recorded games, never start or resume the game clock from a Play tap alone. Wait for the native recorder's authoritative recording acknowledgement; if confirmation or recovery times out, keep or return the clock to paused.

**Why:** Physical iPad tests produced a 25-second game with only a 10-second master because the clock started while the camera was still recovering after Live-link sharing. Earlier tests lost even more film without an obvious UI failure.

**How to apply:** Treat camera-ready, recording-requested, and recording-confirmed as distinct states. Keep one fixed recovery deadline across retries, finalize any uncertain segment before allowing another start, and preserve the clock/film alignment invariant through Live and lifecycle transitions.