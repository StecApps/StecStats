---
name: Mobile replay caching and progressive HLS readiness
description: Non-obvious constraints behind fluid saved-game playback in the Expo app.
---

For progressive MP4 playback, keep the exact signed media URL stable while the app session remains active and enable Expo Video caching. A newly signed query string is a different native cache key even when it refers to the same object.

**Why:** Re-fetching a signed URL on every tab visit made Expo Video discard the practical value of already-buffered ranges, so replay felt like a fresh download.

**How to apply:** Any future mobile player or refactor should preserve source URL identity, opt progressive MP4 into the native cache, and avoid enabling iOS caching for HLS because Expo Video does not support that combination.

Expo Video can accept `replaceAsync()` and only report AVPlayer's source failure later through the `statusChange` event. A player must not treat the resolved replacement promise as proof that media loaded.

**Why:** A valid, fast-start H.264/AAC highlight remained on iOS as a black player with the crossed-out play icon because the delayed native error was ignored.

**How to apply:** Listen for `statusChange: error`; invalidate the reusable signed URL, retry once with a freshly signed URL and iOS caching disabled, then expose a manual retry state instead of leaving the native error screen.

Long-game HLS must become available from consecutive uploaded chunks before the completion sentinel exists. Use an EVENT playlist while encoding is active and switch to a closed VOD playlist only after the sentinel is written.

**Why:** Waiting for the full source download and full-game transcode caused many minutes of blank waiting before a long recording became playable.

**How to apply:** Full-game HLS builds should stream their source sequentially from object storage, upload chunks as they finish, and let AVPlayer refresh a growing playlist. Keep the final sentinel authoritative for exact duration/count and ENDLIST.