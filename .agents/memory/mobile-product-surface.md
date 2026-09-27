---
name: Mobile product surface
description: Coach media surfaces and the browser PWA's prior use
---

The installed iPad app and browser PWA are distinct coach media workflows. The user reports successfully streaming basketball games through the PWA last season and wants the browser-delivered workflow available without App Store approval. This report is evidence of prior use, not proof that today's browser/camera combination survives a full game.

**Why:** An earlier server-side reel change could not be accessed from the installed app, so suggesting a web control was wrong for that moment. The user later corrected the broader inference: the PWA itself had been a working game-day product for them. A subsequent server change made every live session a Daily room, which sent web viewers to an empty Daily feed while the PWA continued publishing WebRTC. Browser live sessions must explicitly choose WebRTC; iPad live sessions remain Daily with cloud recording. Conflating those paths breaks one of them.

**How to apply:** Do not claim that PWA WebRTC streams gain Daily cloud recording or YouTube relay; the browser's local recorder/upload and native app's Daily recording have different durability limits. Preserve explicit transport selection when changing server live-session behavior. Before directing coaches to use the PWA for games, run real-device, full-game validation of capture, live playback, and save/recovery. Do not assume an App Store release is necessary for a browser-delivered coach workflow.