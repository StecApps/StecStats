import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(
  path.resolve(__dirname, "../liveFinalizer.ts"),
  "utf8",
);
const importSource = fs.readFileSync(
  path.resolve(__dirname, "../dailyRecordingImport.ts"),
  "utf8",
);

describe("Live finalization safeguards", () => {
  it("stops the Daily master before YouTube finalization can fail", () => {
    const dailyStop = source.indexOf("await stopDailyRecording(session.dailyRoomName)");
    const youtubeStop = source.indexOf("await stopLiveBroadcast(decryptToken");

    expect(dailyStop).toBeGreaterThan(-1);
    expect(youtubeStop).toBeGreaterThan(dailyStop);
    expect(source).toContain('dailyRecordingStatus: "stopped"');
  });

  it("reissues an idempotent stop while a queued master is not finalized", () => {
    const missingRecording = importSource.indexOf('if (!recording) {');
    const stopRecording = importSource.indexOf(
      "await stopDailyRecording(job.daily_room_name)",
      missingRecording,
    );
    const retry = importSource.indexOf(
      'throw new Error("Daily recording is not finalized yet")',
      stopRecording,
    );

    expect(missingRecording).toBeGreaterThan(-1);
    expect(stopRecording).toBeGreaterThan(missingRecording);
    expect(retry).toBeGreaterThan(stopRecording);
  });
});