---
name: iOS continuous Highlight playback
description: Why iPhone Highlight playback uses the rebuilt combined MP4 rather than source-swapped standalone clips.
---

Prefer the single combined Highlight MP4 on iOS once the generator has rebuilt it as one continuous CFR H.264/AAC timeline. Keep standalone clips as a dormant fallback or for other workflows, but do not source-swap them during normal iPhone playback.

**Why:** Production iPhones repeatedly stopped after 20–40 seconds even though five standalone clips and the full 102-second reel were complete. `playToEnd`, final `timeUpdate`, and terminal `playingChange` fallbacks could not make Expo source replacement reliable across clip boundaries.

**How to apply:** Use the combined reel for playback, offline download, and duration. Preserve the generator's continuous-timeline re-encode and validate the final MP4 before upload; do not regress to stream-copying discontinuous segment timestamps.