import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const source = fs.readFileSync(path.join(__dirname, "watch.tsx"), "utf8");
const liveStream = fs.readFileSync(path.join(__dirname, "../lib/liveStream.ts"), "utf8");

describe("Daily live viewer", () => {
  test("requests short-lived public viewer credentials and joins receive-only", () => {
    expect(liveStream).toContain("/daily-token");
    expect(source).toContain("DailyIframe.createCallObject");
    expect(source).toContain("audioSource: false");
    expect(source).toContain("videoSource: false");
    expect(source).toContain("call.join({ url: roomUrl, token })");
  });

  test("leaves and destroys the Daily call when the watch page unmounts", () => {
    expect(source).toContain("dailyCall?.leave()");
    expect(source).toContain("dailyCall?.destroy()");
  });

  test("does not display the local-recording explanation while Daily is connecting", () => {
    expect(source).toContain('s.videoMode === "daily"');
    expect(source).toContain("dailyFailure ? \"Live video couldn't connect\" : \"The coach is recording locally\"");
  });
});