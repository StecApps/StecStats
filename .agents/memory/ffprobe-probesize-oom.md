---
name: ffprobe probesize OOM and fMP4 duration cascade
description: probesize is a literal RAM allocation; iOS fMP4 videos often need multiple fallback probes to determine duration
---

# ffprobe probesize is a literal RAM allocation

## The rule
Never set `-probesize` or `-analyzeduration` above 500 MB in production. These are literal buffer allocations, not "try harder" hints.

**Why:** Setting `probesize=2147483647` (2 GB) caused ffprobe to allocate 2 GB of RAM immediately. On a container already holding a 3 GB source file, this caused an instant OOM SIGKILL — appearing as a healthcheck failure within seconds of "download complete."

**How to apply:** Use a cascade of probes, each only running if the prior one fails.

## iOS fMP4 / concat MP4 duration detection cascade

iOS MediaRecorder + server-side concat (`ffmpeg -f concat -c copy`) produces fMP4 files where:
- The `mvhd` box duration may be 0 or absent
- The container doesn't report `bit_rate` in the first 10–150 MB of the file header
- ffprobe needs to scan actual media fragments to find duration

Five-stage cascade (each stage only runs if previous returned NaN/0):
1. **10 MB probe** — `format=duration`, fast, works for clean MP4 with moov at front
2. **150 MB stream probe** — `stream=duration` on v:0, covers TS/WebM with seek index
3. **500 MB format probe** — deeper scan into fMP4 fragments, safe RAM-wise
4. **500 MB stream probe** — same depth on video stream directly
5. **Empirical packet scan** — `ffprobe -read_intervals "%+90" packet=pts_time,size` reads first 90 seconds of packets, computes `bytes/sec`, scales to `file_size / bitrate`. Works for any format that has readable packet timestamps.

Fallback: MKV remux still valid for files **< 600 MB** (creates a second copy with seek index). Block it for large files to prevent disk-doubling.

## The MKV remux disk trap
`ffmpeg -f concat -c copy src.mp4 remux.mkv` writes a full second copy. For a 3 GB source this means 6 GB total — filling the container disk and crashing the server. Never remux files > 600 MB.
