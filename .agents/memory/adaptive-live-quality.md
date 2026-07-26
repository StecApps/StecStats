---
name: Adaptive live-stream quality
description: Why live streams froze and how the adaptive controller avoids it; browser caveats for sender.setParameters/getStats.
---

Rule: never ship a fixed high `maxBitrate` with `degradationPreference: "maintain-resolution"` on the broadcast senders — under uplink pressure the encoder holds sharpness and collapses fps, which users experience as the stream "freezing". For sports, always prefer `maintain-framerate` (picture softens instead).

The adaptive controller (`hoops-stats/src/lib/adaptiveStream.ts`) polls `pc.getStats()` across all viewer peers, steps a bitrate/scale ladder down fast (~6 s) and up slow (~21 s), worst-case across viewers because the uplink is shared. The MediaRecorder recording pipeline is unaffected by any sender parameter changes.

**Why:** the fixed 6 Mbps/maintain-resolution setting was the direct cause of user-reported freezing at gyms; local film stayed fine, confirming pipelines are independent.

**How to apply / caveats:**
- iOS Safari does not expose `outbound-rtp.qualityLimitationReason`; step-downs there trigger only via `remote-inbound-rtp` fractionLost/roundTripTime — works, just less pre-emptive.
- Some browsers reject the whole `setParameters` call if `scaleResolutionDownBy` is present — always retry with maxBitrate alone so congestion relief still lands.
- `setParameters` silently no-ops before the offer/answer exchange completes; apply levels only after `setRemoteDescription(answer)`.
- Mild ~30 s oscillation cycles are expected and acceptable; cooldown ticks bound the thrash.
