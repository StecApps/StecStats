---
name: Mobile replay caching and progressive HLS readiness
description: Non-obvious constraints behind fluid saved-game playback in the Expo app.
---

For progressive MP4 playback, keep the exact signed media URL stable while the app session remains active and enable Expo Video caching. A newly signed query string is a different native cache key even when it refers to the same object.

**Why:** Re-fetching a signed URL on every tab visit made Expo Video discard the practical value of already-buffered ranges, so replay felt like a fresh download.

**How to apply:** Any future mobile player or refactor should preserve source URL identity, opt progressive MP4 into the native cache, and avoid enabling iOS caching for HLS because Expo Video does not support that combination.

The public share page playing a reel end-to-end is strong evidence that the combined MP4 is healthy even when native iOS playback dismisses after one or two former clip boundaries.

**Why:** Physical-device Highlight/Lowlight playback exited early while the same shared link played all the way through.

**How to apply:** Do not regenerate the reel from this symptom. Keep public sharing unchanged. A complete local download is not proof that AVPlayer will render it correctly.

Expo Video can accept `replaceAsync()` and only report AVPlayer's source failure later through the `statusChange` event. A player must not treat the resolved replacement promise as proof that media loaded.

**Why:** A valid, fast-start H.264/AAC highlight remained on iOS as a black player with the crossed-out play icon because the delayed native error was ignored.

**How to apply:** Keep the native VideoView mounted while downloading and attaching a source; loading the source before its rendering surface exists can leave a healthy local MP4 black. Listen for `statusChange: error`; invalidate the reusable signed URL, retry once with a freshly signed URL and iOS caching disabled, then expose a manual retry state instead of leaving the native error screen.

For iOS reels, “ready on the server” is not the same as “ready to play on this phone.”

**Why:** Production progressive streams can be cut off and signed URLs can expire while queued, leaving AVPlayer as a blank black surface even though the reel file itself is healthy.

**How to apply:** Keep the native surface mounted behind explicit loading and error states. On cellular, offer a deliberate download-now action for offline Save without making that download the only playback path.

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

Sequential iOS Highlight clips must use an app-owned full-screen modal rather than AVPlayerViewController fullscreen.

**Why:** Replacing the source between clips can dismiss the system fullscreen controller even when both standalone files are valid. Mounting hidden inline and modal VideoViews simultaneously can also attach one player to two native surfaces.

**How to apply:** Render exactly one VideoView for the player at a time. Disable native fullscreen for segmented playback, conditionally swap the inline surface for a visible app-owned modal, keep that modal mounted while `playToEnd` advances sources, and attach only atomically completed local clip files.

Native player teardown errors must never trigger destructive media retry while a reel download is queued or active.

**Why:** Leaving a game can make an empty Expo Video player emit `status:error` just before listener cleanup. Treating that as a bad remote source called force-fresh, paused the background transfer, deleted its partial file, and restarted at zero.

**How to apply:** Before any player-error retry, require a non-empty attached source and exclude queued/downloading manager states. Navigation teardown should only detach UI; download ownership stays with the root singleton manager.

An unfinished HLS build must be re-triggerable from playlist refreshes, and an unproxied short recording is not playable on iOS.

**Why:** A process-local fire-and-forget encoder stopped after autoscale/restart while the client reused its cached playlist token, so no endpoint resumed it. Short games were simultaneously returning raw incompatible media as ready.

**How to apply:** Put the source object path in portable HLS token state, idempotently resume on unfinished playlist reads, and return `proxyReady=false` until short-game proxy media exists.

iOS Highlight/Lowlight playback should bypass reel HLS and use the complete remote progressive MP4 while the offline download continues separately.

**Why:** On a physical iPhone, both Highlight and Lowlight HLS played segment 1 and stopped during segment 2. A local-only build downloaded the reels but showed black video, while public complete-MP4 links played end-to-end.

**How to apply:** When the server advertises reel HLS, attach its separate signed complete-MP4 URL as progressive media instead of the playlist. Keep the manager download only for offline Save/share; do not wait for or attach the local file.

Native iPhone reel HLS should use one app-owned full-screen modal instead of AVPlayerViewController, and download-state refreshes must stay on the combined-reel loader.

**Why:** A completed HLS VOD could play correctly while the system full-screen controller dismissed at a former clip boundary. Separately, the Highlight loader treated `streamIsHls` as segmented playback after the parallel MP4 download changed state, then failed because no standalone clip was selected.

**How to apply:** Disable Expo Video native fullscreen for Highlight/Lowlight HLS on iOS, move the same player between mutually exclusive inline and modal surfaces, and gate standalone-clip loading only on the explicit segmented-playback flag.

Keep Clerk's `getToken` function in a ref when a media-loading callback is itself an effect dependency.

**Why:** Its changing function identity recreated the loader after each state update, producing a stream-token request storm and an eventual native app restart.

**How to apply:** Update a `getToken` ref during render and keep the loader callback dependent only on stable media identifiers/player objects; add a regression test that guards the callback dependency list.

Long-game HLS must become available from consecutive uploaded chunks before the completion sentinel exists. Use an EVENT playlist while encoding is active and switch to a closed VOD playlist only after the sentinel is written.

**Why:** Waiting for the full source download and full-game transcode caused many minutes of blank waiting before a long recording became playable.

**How to apply:** Full-game HLS builds should stream their source sequentially from object storage, upload chunks as they finish, and let AVPlayer refresh a growing playlist. Keep the final sentinel authoritative for exact duration/count and ENDLIST.

Film Room HLS playback chunks must use a separate namespace and shorter duration than the six-minute proxy chunks used for reel extraction. Every HLS playlist must derive TARGETDURATION from its longest actual segment, never the nominal segment setting.

**Why:** Reusing six-minute reel chunks meant a 1.1 GB VP9 game could encode for more than ten minutes without making even the first frame available. AVPlayer rejected a completed reel playlist before requesting segment 1 when FFmpeg produced a segment slightly longer than the advertised four-second target.

**How to apply:** Use short playback-only segments, calculate EXTINF and TARGETDURATION from measured manifest/sidecar durations, terminate completed playlists with a newline, and sweep media, metadata, and sentinel together when a game is deleted. FFmpeg can advertise an exact integer EXTINF (for example 4.000) while the muxed TS timeline is slightly longer (for example 4.023); give exact integer target boundaries one second of headroom or AVPlayer can reject the playlist before requesting segment zero.

Long-game playback encodes must yield the global ffmpeg serializer in bounded batches; segment size alone does not provide fairness when one ffmpeg process still encodes the full game.

**Why:** A 34-minute HLS build held the sole ffmpeg slot continuously, so a second game logged that its build started but could not produce any segment until the first entire transcode ended.

**How to apply:** Run a small number of playback segments per ffmpeg invocation, rejoin the queue between batches, and use fast pre-input seeking only for the authenticated loopback Range source. Detect EOF with a zero-output batch before writing the final sentinel.

Reel HLS token issuance must never download or probe the media before returning, and a late HLS result must not replace a local reel that has already started playing.

**Why:** Production token requests blocked for 6–24 seconds while ffprobe waited on the complete reel. The old local MP4 played during that delay, then the late HLS source replacement dismissed playback after roughly one and a half clips; no playlist or segment request was ever made.

**How to apply:** Mint the object/type-bound playlist token immediately. Let the first playlist request probe duration and mint a second portable token containing exact segment count/duration. Segment routes accept only that fully bound token.

Do not scan the game history for ready Highlight/Lowlight reels when the mobile app activates.

**Why:** Fetching both reel statuses for up to 30 games produced waves of roughly 60 requests, automatically queued unrelated downloads, competed with current-game Film Room preparation, and made the app appear stuck.

**How to apply:** Account activation may restore existing download metadata, but only the game/tab the coach opens may request a reel status, stream token, or local download. Automatic master-film upload is separate and must remain app-wide.