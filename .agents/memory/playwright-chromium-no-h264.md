---
name: Playwright Chromium cannot decode H.264/AAC
description: e2e video playback of MP4/H.264 always fails in the test browser; verify at the network level instead.
---

Rule: the Playwright test browser used by `runTest` has no proprietary codecs — `canPlayType('video/mp4; codecs="avc1..., mp4a...")` returns `""` while VP9/WebM returns `"probably"`. Any e2e step that plays an H.264/AAC MP4 fails with `MEDIA_ERR_SRC_NOT_SUPPORTED` even when the app is serving the file perfectly.

**Why:** Discovered while verifying the film-room proxy MP4 fix — playback "failed" in e2e despite the signed URL serving 206 + video/mp4; the sandbox codec gap mimicked an app bug.

**How to apply:** For MP4 playback features, have the e2e evaluate network-level evidence in-page instead: fetch the API for the URL, assert it has no unsigned extra params, then `fetch(url, {headers:{Range:'bytes=0-1023'}})` and assert 200/206 + `video/mp4`. Real browsers (iOS Safari, Chrome, Firefox) all decode H.264/AAC natively. WebM/VP9 fixtures DO play in the test browser if visual playback must be tested.
