/**
 * Music continuity regression test.
 *
 * Confirms that the combined concat+music single-pass in concatSegments mixes
 * music across the full reel so the track plays continuously from start to
 * finish — not per-segment (which would restart the track at every clip
 * boundary and produce an audible pop/gap).
 *
 * Oracle design
 * ─────────────
 * The music track starts with 0.5 s of digital silence, then a continuous
 * 880 Hz sine tone.  After mixing a two-clip reel (3 s + 3 s = 6 s total):
 *
 *   Single-pass concat+music (correct):
 *     Music plays from t=0 → t=6 s once.  At the boundary (t≈3 s) the track
 *     is already 2.5 s into the tone phase → loud signal, mean ≈ −3 dBFS.
 *
 *   Per-segment mix (old bug / negative control):
 *     Each 3 s clip is mixed with music restarting from t=0.  The second clip
 *     therefore starts with 0.5 s of silence.  After concatenating the two
 *     mixed clips, t=3.0–3.5 s is the restart silence → mean ≈ −91 dBFS.
 *
 * Measuring mean_volume in the window [3.05 s, 3.4 s] (safely inside the
 * 0.5 s restart-silence window) unambiguously separates the two cases with
 * ~88 dB of margin.
 */

import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { execFile } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";

import { concatSegments, mixMusicIntoReel, HighlightError } from "../highlightGenerator";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// ffmpeg helpers
// ---------------------------------------------------------------------------

async function ffmpegRun(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("ffmpeg", args, { maxBuffer: 10 * 1024 * 1024 });
}

/**
 * Return the mean audio volume (dBFS) for a slice of a media file.
 * ffmpeg's volumedetect filter writes its summary to stderr.
 * Returns a number like −3.2 (≈ 0 dBFS = loud) or −91 (≈ silence).
 */
async function meanVolumeAt(
  filePath: string,
  startSec: number,
  durationSec: number,
): Promise<number> {
  const { stderr } = await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-ss", String(startSec),
      "-t", String(durationSec),
      "-i", filePath,
      "-filter:a", "volumedetect",
      "-vn", "-f", "null", "-",
    ],
    { maxBuffer: 10 * 1024 * 1024 },
  );
  const m = /mean_volume:\s*([-\d.]+)\s*dB/.exec(stderr);
  if (!m) {
    throw new Error(
      `volumedetect produced no mean_volume output.\nstderr tail: ${stderr.slice(-600)}`,
    );
  }
  return parseFloat(m[1]);
}

// ---------------------------------------------------------------------------
// Synthetic asset builders
// ---------------------------------------------------------------------------

/** Short video-only (no audio stream) MP4 clip via lavfi color source. */
async function makeVideoClip(outPath: string, durationSec: number): Promise<void> {
  await ffmpegRun([
    "-y",
    "-f", "lavfi",
    "-i", `color=c=blue:size=320x240:rate=30:duration=${durationSec}`,
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "40",
    "-g", "30", "-keyint_min", "30", "-sc_threshold", "0",
    "-an",
    outPath,
  ]);
}

/**
 * WAV music track: 0.5 s digital silence, then a continuous 880 Hz sine tone.
 *
 * Expression: sin(2π·880·t) · gte(t, 0.5)
 *   gte(t, 0.5) returns 0 when t < 0.5 s, 1 thereafter → silence then tone.
 * Note: the comma in gte(t\,0.5) is escaped with \\ for ffmpeg's filter parser.
 */
async function makeMusicTrack(outPath: string, durationSec: number): Promise<void> {
  await ffmpegRun([
    "-y",
    "-f", "lavfi",
    "-i", `aevalsrc=sin(2*PI*880*t)*gte(t\\,0.5):s=44100:d=${durationSec}`,
    "-c:a", "pcm_s16le",
    outPath,
  ]);
}

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const CLIP_SEC = 3;            // duration of each individual clip
const NUM_CLIPS = 2;           // number of clips to concatenate
const MUSIC_SILENCE_SEC = 0.5; // leading silence in the music track
const BOUNDARY_SEC = CLIP_SEC; // where clip 2 begins (= 3 s into the reel)

// Probe window: 3.05–3.45 s — safely inside the 0.5 s silence burst that a
// per-segment restart creates at t=3 s, but far enough from the boundary
// that MP4 mux latency doesn't affect the measurement.
const PROBE_START = BOUNDARY_SEC + 0.05;
const PROBE_DURATION = 0.40;

// Anything louder than −40 dBFS is "audible tone"; quieter is "silence".
const LOUD_DB_MIN = -40;
const SILENT_DB_MAX = -40;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("concatSegments (single-pass) — music continuity across clip boundaries", () => {
  let tmpDir: string;
  let clip1: string;
  let clip2: string;
  let musicPath: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "music-continuity-"));
    clip1     = path.join(tmpDir, "clip1.mp4");
    clip2     = path.join(tmpDir, "clip2.mp4");
    musicPath = path.join(tmpDir, "music.wav");

    await Promise.all([
      makeVideoClip(clip1, CLIP_SEC),
      makeVideoClip(clip2, CLIP_SEC),
      makeMusicTrack(musicPath, NUM_CLIPS * CLIP_SEC + 10), // longer than the reel
    ]);
  }, 60_000);

  afterAll(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 1. Correct path: single-pass concat+music
  // ──────────────────────────────────────────────────────────────────────────
  it(
    "single-pass concat+music: music is audible at the clip boundary (track plays through)",
    async () => {
      // Single ffmpeg invocation: concat list + music input → final reel.
      // No intermediate file is written; this is the production code path.
      const reelPath = path.join(tmpDir, "reel_singlepass.mp4");
      await concatSegments([clip1, clip2], tmpDir, reelPath, /* hasAudio */ false, musicPath);

      // At t=3.05–3.45 s the music has been playing for 2.55 s past its
      // silence intro → we are deep into the tone phase → loud signal.
      const vol = await meanVolumeAt(reelPath, PROBE_START, PROBE_DURATION);

      expect(
        vol,
        `Single-pass reel: expected audible music (> ${LOUD_DB_MIN} dBFS) at ` +
          `t=${PROBE_START}–${(PROBE_START + PROBE_DURATION).toFixed(2)} s ` +
          `but measured ${vol.toFixed(1)} dB. ` +
          "The music may have been truncated or not mixed across the full reel.",
      ).toBeGreaterThan(LOUD_DB_MIN);
    },
    120_000,
  );

  // ──────────────────────────────────────────────────────────────────────────
  // 2. Negative control: per-segment mixing (the old bug)
  // ──────────────────────────────────────────────────────────────────────────
  it(
    "per-segment mix (regression control): music restarts at the boundary, producing detectable silence",
    async () => {
      // Mix music into EACH clip separately before concatenating — this is the
      // bug that was fixed. The music track restarts at the start of each clip,
      // so the second clip begins with the track's 0.5 s leading silence.
      const mixed1 = path.join(tmpDir, "mixed_seg1.mp4");
      const mixed2 = path.join(tmpDir, "mixed_seg2.mp4");
      await mixMusicIntoReel(clip1, mixed1, musicPath, /* reelHasAudio */ false);
      await mixMusicIntoReel(clip2, mixed2, musicPath, /* reelHasAudio */ false);

      const buggyReel = path.join(tmpDir, "reel_perseg.mp4");
      await concatSegments([mixed1, mixed2], tmpDir, buggyReel, /* hasAudio */ true);

      // At t=3.05–3.45 s, the second clip just started and the music is in its
      // 0.5 s silence phase (0 ≤ track-local t < 0.5 s) → near-silent signal.
      const vol = await meanVolumeAt(buggyReel, PROBE_START, PROBE_DURATION);

      expect(
        vol,
        `Per-segment reel: expected silence (< ${SILENT_DB_MAX} dBFS) at ` +
          `t=${PROBE_START}–${(PROBE_START + PROBE_DURATION).toFixed(2)} s ` +
          `(music restart) but measured ${vol.toFixed(1)} dB. ` +
          `This negative control verifies the oracle can detect a per-segment restart. ` +
          `If this assertion fails, check that the music track's leading silence ` +
          `(${MUSIC_SILENCE_SEC} s) is intact and the probe window is within it.`,
      ).toBeLessThan(SILENT_DB_MAX);
    },
    120_000,
  );
});

// ---------------------------------------------------------------------------
// Missing music track — pre-flight guard
// ---------------------------------------------------------------------------

describe("mixMusicIntoReel — missing music track file", () => {
  let tmpDir: string;
  let videoPath: string;
  let outPath: string;

  beforeAll(async () => {
    tmpDir    = await fs.mkdtemp(path.join(os.tmpdir(), "music-missing-"));
    videoPath = path.join(tmpDir, "clip.mp4");
    outPath   = path.join(tmpDir, "reel.mp4");

    // Make a minimal silent video clip to use as the reel input.
    await execFileAsync("ffmpeg", [
      "-y",
      "-f", "lavfi", "-i", "color=c=black:size=320x240:rate=30:duration=2",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "40",
      "-an",
      videoPath,
    ]);
  }, 60_000);

  afterAll(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it(
    "rejects with a HighlightError when the music track path does not exist",
    async () => {
      const missingTrack = path.join(tmpDir, "no_such_track.wav");

      await expect(
        mixMusicIntoReel(videoPath, outPath, missingTrack, /* reelHasAudio */ false),
      ).rejects.toSatisfy((err: unknown) => {
        if (!(err instanceof HighlightError)) return false;
        return err.message.includes("Music track file could not be opened");
      });
    },
    30_000,
  );
});
