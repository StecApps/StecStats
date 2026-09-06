---
name: iOS DownloadResumable signed URLs
description: Why Expo's native iOS resume blob cannot support refreshing an expired signed URL
---

On iOS, Expo's legacy `DownloadResumable` uses `URLSessionDownloadTask`. Partial bytes remain in URLSession's temporary storage and are represented by the opaque resume-data blob; they are not written progressively to the requested destination path.

The resume blob also embeds the original URL request. Reconstructing a resumable with a new URL does not replace that request because iOS starts it with `downloadTask(withResumeData:)`.

**Why:** A simulated `.part` file and a fresh URL argument can make Jest pass while the real iOS task still retries the expired request and has no app-visible partial file.

**How to apply:** When expiring URLs must be refreshed, stream bytes into an account-scoped app-owned partial file and resume with a validated HTTP Range response. Reserve native resume blobs for stable URLs.