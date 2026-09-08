import { describe, expect, it } from "vitest";
import {
  buildContinuous720pEncodeArgs,
  buildContinuousConcatArgs,
} from "../videoTimeline";

describe("continuous video timeline ffmpeg arguments", () => {
  it("re-encodes merged games instead of preserving clip discontinuities", () => {
    const args = buildContinuousConcatArgs("/tmp/list.txt", "/tmp/merged.mp4");

    expect(args).not.toContain("copy");
    expect(args).toContain("setpts=N/(30*TB)");
    expect(args).toContain("aresample=async=1:first_pts=0,asetpts=N/SR/TB");
    expect(args).toContain("libx264");
    expect(args).toContain("aac");
    expect(args.at(-1)).toBe("/tmp/merged.mp4");
  });

  it("forces a continuous 720p repair timeline", () => {
    const args = buildContinuous720pEncodeArgs();

    expect(args).not.toContain("copy");
    expect(args).toContain("scale=-2:720,setpts=N/(30*TB)");
    expect(args).toContain("aresample=async=1:first_pts=0,asetpts=N/SR/TB");
    expect(args).toContain("yuv420p");
  });
});