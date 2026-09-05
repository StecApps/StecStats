---
name: Mobile replay caching and progressive HLS readiness
description: Non-obvious constraints behind fluid saved-game playback in the Expo app.
---

For progressive MP4 playback, keep the exact signed media URL stable while the app session remains active and enable Expo Video caching. A newly signed query string is a different native cache key even when it refers to the same object.

**Why:** Re-fetching a signed URL on every tab visit made Expo Video discard the practical value of already-buffered ranges, so replay felt like a fresh download.

**How to apply:** Any future mobile player or refactor should preserve source URL identity, opt progressive MP4 into the native cache, and avoid enabling iOS caching for HLS because Expo Video does not support that combination. For generated highlight/lowlight reels on iOS, download the complete signed-GCS MP4 to the app cache and give AVPlayer the local file URI.

Expo Video can accept `replaceAsync()` and only report AVPlayer's source failure later through the `statusChange` event. A player must not treat the resolved replacement promise as proof that media loaded.

**Why:** A valid, fast-start H.264/AAC highlight remained on iOS as a black player with the crossed-out play icon because the delayed native error was ignored.

**How to apply:** Keep the native VideoView mounted while downloading and attaching a source; loading the source before its rendering surface exists can leave a healthy local MP4 black. Listen for `statusChange: error`; invalidate the reusable signed URL, retry once with a freshly signed URL and iOS caching disabled, then expose a manual retry state instead of leaving the native error screen.

For iOS reels, “ready on the server” is not the same as “ready to play on this phone.” Do not attach the temporary remote URL while a persistent download is queued or paused by a Wi‑Fi-only preference.

**Why:** Production progressive streams can be cut off and signed URLs can expire while queued, leaving AVPlayer as a blank black surface even though the reel file itself is healthy.

**How to apply:** Keep the native surface mounted behind an explicit waiting/downloading panel. Attach only the completed account-scoped local file; on cellular, offer a deliberate download-now action rather than showing an empty player.

iOS highlight/lowlight playback must not stream either directly from a signed GCS URL or through the Replit API proxy.

**Why:** AVPlayer rejected valid fast-start MP4s when reading GCS signed URLs, while the API byte-range workaround produced valid 206 responses that the production proxy aborted after roughly 1–2 seconds.

**How to apply:** Use the signed GCS URL only as a native file-download source, validate the completed file is non-empty, then give AVPlayer the bare local URI with automatic content detection and native caching disabled. Key the on-disk filename by the reel object path so it survives app relaunches without becoming stale after regeneration. Check disk before requesting a stream token, show that the reel is downloaded, and save/share the local URI rather than the expiring remote URL. Re-download after regeneration or an explicit retry, and expose download failures instead of swallowing them.

Keep Clerk's `getToken` function in a ref when a media-loading callback is itself an effect dependency.

**Why:** Its changing function identity recreated the loader after each state update, producing a stream-token request storm and an eventual native app restart.

**How to apply:** Update a `getToken` ref during render and keep the loader callback dependent only on stable media identifiers/player objects; add a regression test that guards the callback dependency list.

Long-game HLS must become available from consecutive uploaded chunks before the completion sentinel exists. Use an EVENT playlist while encoding is active and switch to a closed VOD playlist only after the sentinel is written.

**Why:** Waiting for the full source download and full-game transcode caused many minutes of blank waiting before a long recording became playable.

**How to apply:** Full-game HLS builds should stream their source sequentially from object storage, upload chunks as they finish, and let AVPlayer refresh a growing playlist. Keep the final sentinel authoritative for exact duration/count and ENDLIST.