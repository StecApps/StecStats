import { describe, expect, it } from "vitest";
import { isEligibleForDirectMaster } from "../highlightGenerator";

const fiveMinutes = 5 * 60 * 1000;
const maxBytes = 120 * 1024 * 1024;

describe("short-master reel quality guard", () => {
  it("accepts an MP4 exactly at both configured bounds", () => {
    expect(isEligibleForDirectMaster({
      durationMs: fiveMinutes,
      contentType: "video/mp4",
      sizeBytes: maxBytes,
    })).toBe(true);
  });

  it("rejects duration and size just over the bounds", () => {
    expect(isEligibleForDirectMaster({
      durationMs: fiveMinutes + 1,
      contentType: "video/mp4",
      sizeBytes: maxBytes,
    })).toBe(false);
    expect(isEligibleForDirectMaster({
      durationMs: fiveMinutes,
      contentType: "video/mp4",
      sizeBytes: maxBytes + 1,
    })).toBe(false);
  });

  it("rejects missing or non-MP4 metadata", () => {
    for (const metadata of [
      { contentType: undefined, sizeBytes: maxBytes },
      { contentType: "video/mp4", sizeBytes: undefined },
      { contentType: "video/webm", sizeBytes: maxBytes },
      { contentType: undefined, sizeBytes: undefined },
    ]) {
      expect(isEligibleForDirectMaster({
        durationMs: fiveMinutes,
        ...metadata,
      })).toBe(false);
    }
  });

  it("rejects unknown, zero, and negative durations or sizes", () => {
    for (const durationMs of [null, 0, -1]) {
      expect(isEligibleForDirectMaster({
        durationMs,
        contentType: "video/mp4",
        sizeBytes: maxBytes,
      })).toBe(false);
    }
    for (const sizeBytes of [null, 0, -1, Number.NaN]) {
      expect(isEligibleForDirectMaster({
        durationMs: fiveMinutes,
        contentType: "video/mp4",
        sizeBytes,
      })).toBe(false);
    }
  });

  it("normalizes an MP4 content-type parameter and casing", () => {
    expect(isEligibleForDirectMaster({
      durationMs: 1,
      contentType: "Video/MP4; charset=binary",
      sizeBytes: 1,
    })).toBe(true);
  });
});