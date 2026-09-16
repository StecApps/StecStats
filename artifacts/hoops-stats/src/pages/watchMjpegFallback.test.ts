import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(path.join(__dirname, "watch.tsx"), "utf8");

describe("MJPEG runtime fallback", () => {
  test("removes the score-only overlay when an MJPEG mode arrives", () => {
    const mjpegBranches = source.match(
      /message\.videoMode === "mjpeg"[\s\S]*?setScoreOnly\(false\)[\s\S]*?setIsMjpeg\(true\)/g,
    );
    expect(mjpegBranches).toHaveLength(2);
  });
});