---
name: iOS MP4 multi-half recording concat
description: Why raw Blob concatenation of iOS MediaRecorder MP4 segments produces an invalid file and how the server-side fix works.
---

## The rule
Never raw-concatenate multiple iOS MP4 recording segments as `new Blob([half1, half2])`. Upload each segment separately, then merge server-side via `POST /api/storage/concat-segments`.

**Why:** iOS Safari MediaRecorder uses `video/mp4` (not WebM). Each recording session writes its own `ftyp` + `moov` atom. Concatenating two MP4 blobs as raw bytes produces an invalid file — ffmpeg reads only the first segment (~30 min for a half), silently drops everything after, and filters all second-half events from the reel with no error.

WebM raw-concat **is** fine because WebM clusters have independent timestamps that ffmpeg reads sequentially.

**How to apply:**
- In `handleSave` (record.tsx), detect MP4 multi-segment: `mimeType.includes("mp4") && allParts.length > 1`
- Upload each half individually via `uploadVideoBlob`, collect objectPaths
- POST to `/api/storage/concat-segments` with `{ segmentPaths: [...] }`
- Use the returned `videoObjectPath` for the game save

The server endpoint:
1. Gets signed read URLs for each segment path
2. Writes an ffmpeg filelist (`file 'url'` per line)
3. Runs `ffmpeg -f concat -safe 0 -protocol_whitelist file,http,https,tcp,tls,crypto -i filelist.txt -c copy -movflags +faststart output.mp4`
4. Streams output to GCS via `uploadLocalFileAsObjectEntity` (no full-file memory buffer)
5. Sets ACL policy and returns the merged path

The concat demuxer with `-c copy` (no re-encoding) is fast and correctly offsets the second segment's timestamps to follow the first, making all events from both halves seekable in one continuous video.

## Diagnosis
If a game's reel only shows first-half plays: check whether the recording used "Start 2nd Half". The stored video's effective duration (as read by ffmpeg) will be ~half the total game time, and all events with `videoTimestampMs > duration_ms` are silently filtered.
