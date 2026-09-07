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

Completed offline reels belong in the app's document storage, and a transient AVPlayer error must never automatically invalidate the local file it is currently reading.

**Why:** The retry path once deleted an actively playing reel after a native status error, causing partial playback to exit and moving a completed item back into the queue. iOS can also purge cache-directory media.

**How to apply:** Migrate legacy completed cache files into account-scoped document storage on activation. For errors on a `file:` source, preserve the file and show explicit retry rather than deleting it automatically.

A completed local reel download must be committed to React state before attaching it to Expo Video, and load generations must be assigned when each async load starts.

**Why:** A valid 56 MB H.264/AAC reel with visible decoded frames still rendered as an empty black native surface. Overlapping discovery, retry, and resume loads could also finish out of order and attach an obsolete URI.

**How to apply:** Commit a unique source request first, attach it in a serialized post-commit effect, reject stale success and error completions after every await, and route background resume through that same guarded loader.

Reel downloads must write to a `.part` path and atomically promote only after HTTP status and expected byte count are verified.

**Why:** Writing an NSURLSession download directly into the final MP4 let AVPlayer open changing bytes, report only the first seconds, and keep stale duration state. Background resume also invalidated active transfers and restarted them at zero.

**How to apply:** Never attach the transfer destination. Preserve active background tasks across screen/app lifecycle changes; only explicit failed-download retry should start a new transfer.

Downloaded Expo Video reels must attach as explicit uncached progressive file sources, and repeated state updates must not replace the same source while it is playing.

**Why:** A complete local MP4 could seek to its end but stall during sequential playback when attached as an ambiguous bare URI; duplicate attachment requests could also reset AVPlayer mid-play.

**How to apply:** Pass local files through the typed playback-source helper, track the currently attached URI, skip identical replacements, and clear that identity before explicit retry/regeneration because those reuse the same deterministic path.

Once a local reel has rendered or begun playing, a transient native status error must not unmount its VideoView or automatically replace its source.

**Why:** On iOS, either action dismisses the fullscreen AVPlayerViewController back to the game screen, making a valid complete Highlight look truncated.

**How to apply:** Keep the VideoView mounted beneath any error overlay, track whether playback actually started, and offer an explicit same-file resume at the last observed time. Automatic reattachment is only safe before the first frame.

Native player teardown errors must never trigger destructive media retry while a reel download is queued or active.

**Why:** Leaving a game can make an empty Expo Video player emit `status:error` just before listener cleanup. Treating that as a bad remote source called force-fresh, paused the background transfer, deleted its partial file, and restarted at zero.

**How to apply:** Before any player-error retry, require a non-empty attached source and exclude queued/downloading manager states. Navigation teardown should only detach UI; download ownership stays with the root singleton manager.

An unfinished HLS build must be re-triggerable from playlist refreshes, and an unproxied short recording is not playable on iOS.

**Why:** A process-local fire-and-forget encoder stopped after autoscale/restart while the client reused its cached playlist token, so no endpoint resumed it. Short games were simultaneously returning raw incompatible media as ready.

**How to apply:** Put the source object path in portable HLS token state, idempotently resume on unfinished playlist reads, and return `proxyReady=false` until short-game proxy media exists.

iOS highlight/lowlight playback must not stream either directly from a signed GCS URL or through the Replit API proxy.

**Why:** AVPlayer rejected valid fast-start MP4s when reading GCS signed URLs, while the API byte-range workaround produced valid 206 responses that the production proxy aborted after roughly 1–2 seconds.

**How to apply:** Use the signed GCS URL only as a native file-download source, validate the completed file is non-empty, then give AVPlayer the bare local URI with automatic content detection and native caching disabled. Key the on-disk filename by the reel object path so it survives app relaunches without becoming stale after regeneration. Check disk before requesting a stream token, show that the reel is downloaded, and save/share the local URI rather than the expiring remote URL. Re-download after regeneration or an explicit retry, and expose download failures instead of swallowing them.

Keep Clerk's `getToken` function in a ref when a media-loading callback is itself an effect dependency.

**Why:** Its changing function identity recreated the loader after each state update, producing a stream-token request storm and an eventual native app restart.

**How to apply:** Update a `getToken` ref during render and keep the loader callback dependent only on stable media identifiers/player objects; add a regression test that guards the callback dependency list.

Long-game HLS must become available from consecutive uploaded chunks before the completion sentinel exists. Use an EVENT playlist while encoding is active and switch to a closed VOD playlist only after the sentinel is written.

**Why:** Waiting for the full source download and full-game transcode caused many minutes of blank waiting before a long recording became playable.

**How to apply:** Full-game HLS builds should stream their source sequentially from object storage, upload chunks as they finish, and let AVPlayer refresh a growing playlist. Keep the final sentinel authoritative for exact duration/count and ENDLIST.

Film Room HLS playback chunks must use a separate namespace and shorter duration than the six-minute proxy chunks used for reel extraction. A growing playlist may expose a segment only after its media and exact-duration sidecar are both uploaded.

**Why:** Reusing six-minute reel chunks meant a 1.1 GB VP9 game could encode for more than ten minutes without making even the first frame available. Nominal EXTINF values also become invalid when keyframe alignment makes a segment longer than its target.

**How to apply:** Use short playback-only segments, calculate progressive EXTINF and TARGETDURATION from exact sidecars, build recovered sentinels from those sidecars, and sweep media, metadata, and sentinel together when a game is deleted.

Long-game playback encodes must yield the global ffmpeg serializer in bounded batches; segment size alone does not provide fairness when one ffmpeg process still encodes the full game.

**Why:** A 34-minute HLS build held the sole ffmpeg slot continuously, so a second game logged that its build started but could not produce any segment until the first entire transcode ended.

**How to apply:** Run a small number of playback segments per ffmpeg invocation, rejoin the queue between batches, and use fast pre-input seeking only for the authenticated loopback Range source. Detect EOF with a zero-output batch before writing the final sentinel.

Do not scan the game history for ready Highlight/Lowlight reels when the mobile app activates.

**Why:** Fetching both reel statuses for up to 30 games produced waves of roughly 60 requests, automatically queued unrelated downloads, competed with current-game Film Room preparation, and made the app appear stuck.

**How to apply:** Account activation may restore existing download metadata, but only the game/tab the coach opens may request a reel status, stream token, or local download. Automatic master-film upload is separate and must remain app-wide.