---
name: Merged game source timelines
description: Why independently recorded game videos must be normalized before derivative reel generation
---

Never stream-copy independently recorded game videos into a merged master. Rebuild one continuous CFR video/audio timeline before attaching the merged source or generating Highlights and Lowlights from it.

**Why:** A concat-demuxed WebM can appear as one valid, decodable container while retaining a timestamp or keyframe discontinuity. Regenerated reels then fail deterministically shortly after entering the second source clip, so cache resets and playback retries cannot fix it.

**How to apply:** Future merge jobs should encode continuous H.264/AAC timestamps. For an existing malformed merged WebM, force a full 720p repair of the master before regenerating derivatives; metadata-only repair is insufficient.