---
name: YouTube live embedding workaround
description: How to create embeddable YouTube Live broadcasts when liveBroadcasts.insert rejects enableEmbed.
---

Some YouTube channels return `invalidEmbedSetting` when `contentDetails.enableEmbed: true` is sent to `liveBroadcasts.insert`, even though the resulting live video can be made embeddable through the regular Videos API. Create the unlisted broadcast with `enableEmbed: false`, then call `videos.update` with `status.embeddable: true` before starting the RTMP relay.

**Why:** A production broadcast creation failed with “Embed setting was invalid.” The app then ended the session, so its shared link immediately became invalid.

**How to apply:** Treat successful video-status update as a prerequisite for starting Daily RTMP. Do not return or share the session as live until the video is confirmed embeddable.