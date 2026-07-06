---
name: Game highlight reel pipeline
description: How the good-plays MP4 is generated, and the robustness rules around its status field
---

# Game highlight reel

Turns a recorded game into one shareable MP4 of only good plays (made shots, rebounds, assists, steals, blocks; excludes misses/turnovers), with a burned-in caption per clip ("PlayerName — StatLabel"). Server builds it with ffmpeg (per-event windows, overlapping windows merged into segments, drawtext via textfile, TS segments concat to faststart MP4), uploads to object storage, tracks status in DB.

## Highlight status is a fire-and-forget state machine — two rules keep it honest
**Rule 1 — a `processing` status must be recoverable.** The in-process in-flight guard is ephemeral; if the server restarts mid-job the DB stays `processing` forever and the user can never regenerate. Fix: persist a start timestamp and treat `processing` older than a timeout (currently 10 min) as abandoned/retryable.
**Why:** without this, one crash permanently bricks a game's reel with no user-facing recovery.

**Rule 2 — editing a game must invalidate its reel.** The game PATCH handler clears highlightObjectPath/status/error/startedAt, because the stored MP4 reflects the old events/video. Otherwise a stale `ready` reel keeps serving after stats/video change.
**How to apply:** any new field that changes what the reel would contain must also reset the highlight fields in the same update.
