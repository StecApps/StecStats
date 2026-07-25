---
name: Halftime-gap math must be mirrored everywhere timestamps map to video time
description: Repaired two-half videos have the halftime gap removed; every timestamp→video-position conversion (server and client) must subtract it.
---

## The rule

For repaired two-half games, the stitched video file has the halftime gap removed, but event timestamps keep original recording-clock values. Every place that converts an event timestamp to a video position must apply the same formula:

```
gapAdj = (half2StartMs != null && halftimeGapMs != null && ts >= half2StartMs) ? halftimeGapMs : 0
videoSec = (ts - videoOffsetMs - gapAdj) / 1000
```

**Why:** The server's `buildSegments` (highlightGenerator) had this math, but the frontend FilmRoom only subtracted `videoOffsetMs`. That made second-half events seek to the wrong spot and — once end-of-footage flagging was added — falsely marked them "Not on film" (timestamps exceed stitched duration by the gap).

**How to apply:** FilmRoom now has a `toVideoSec()` helper and receives `videoHalf2StartMs`/`videoHalftimeGapMs` (serialized on Game responses). Any new UI or server code that seeks, positions markers, or compares against video duration must go through the same adjusted conversion — never raw `(ts - offset) / 1000`.

Related: `videoDurationMs` (server-probed true footage end) is the authoritative end-of-film boundary; browser `video.duration` is Infinity for live-recorded WebM. Legacy games self-heal via a lazy probe scheduled from the highlight/lowlight GET endpoints — production backfill needs no manual SQL (prod SQL is read-only anyway), just publish + first Film-page load.
