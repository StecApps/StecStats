export function buildContinuousConcatArgs(
  concatListPath: string,
  outPath: string,
): string[] {
  return [
    "-y",
    "-fflags", "+genpts",
    "-f", "concat",
    "-safe", "0",
    "-i", concatListPath,
    "-vf", "setpts=N/(30*TB)",
    "-af", "aresample=async=1:first_pts=0,asetpts=N/SR/TB",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-profile:v", "main",
    "-pix_fmt", "yuv420p",
    "-r", "30",
    "-c:a", "aac",
    "-ar", "44100",
    "-b:a", "128k",
    "-ac", "2",
    "-avoid_negative_ts", "make_zero",
    "-movflags", "+faststart",
    outPath,
  ];
}

export function buildContinuous720pEncodeArgs(): string[] {
  return [
    "-vf", "scale=-2:720,setpts=N/(30*TB)",
    "-af", "aresample=async=1:first_pts=0,asetpts=N/SR/TB",
    "-c:v", "libx264",
    "-crf", "23",
    "-preset", "veryfast",
    "-profile:v", "main",
    "-pix_fmt", "yuv420p",
    "-r", "30",
    "-c:a", "aac",
    "-ar", "44100",
    "-b:a", "128k",
    "-ac", "2",
    "-avoid_negative_ts", "make_zero",
    "-movflags", "+faststart",
  ];
}