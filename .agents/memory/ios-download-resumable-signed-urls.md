---
name: iOS DownloadResumable signed URLs
description: Why Expo's native iOS resume blob cannot support refreshing an expired signed URL
---

On iOS, Expo's legacy `DownloadResumable` uses `URLSessionDownloadTask`. Partial bytes remain in URLSession's temporary storage and are represented by the opaque resume-data blob; they are not written progressively to the requested destination path.

The resume blob also embeds the original URL request. Reconstructing a resumable with a new URL does not replace that request because iOS starts it with `downloadTask(withResumeData:)`.

**Why:** A simulated `.part` file and a fresh URL argument can make Jest pass while the real iOS task still retries the expired request and has no app-visible partial file.

**How to apply:** When expiring URLs must be refreshed, stream bytes into an account-scoped app-owned partial file and preserve that file across transient network failures. Use small, explicit bounded ranges rather than `bytes=<offset>-`; the production proxy can close an open-ended remainder response and cause an endless downloading/queued loop. Resume through the authenticated server endpoint whose Range body comes from the GCS SDK—not through a signed object URL, which can return incorrect mid-file bytes with the expected length. Byte count alone is not integrity proof: expose the full object's checksum on every Range response, verify the completed local file before promotion, and bump the manifest generation whenever potentially damaged completed files must be cleared once.

Account-scoped download enqueueing must wait until the download manager has activated the current Clerk account.

**Why:** On a cold launch or fresh install, the game screen could receive a reel URL before account storage finished loading. The manager silently ignored the enqueue because no account was active, so production saw no MP4 request and the download never began.

**How to apply:** Expose account-specific manager readiness through context. Playback may attach independently, but download effects must rerun when readiness becomes true; never queue ownership-sensitive media under a null or stale account.