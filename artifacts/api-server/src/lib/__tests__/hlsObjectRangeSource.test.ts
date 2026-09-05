import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("long-game HLS source access", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../highlightGenerator.ts"),
    "utf8",
  );

  it("feeds ffmpeg through an authenticated loopback Range server", () => {
    expect(source).toContain("async function withObjectRangeServer");
    expect(source).toContain('file.createReadStream({ start, end })');
    expect(source).toContain('"Accept-Ranges": "bytes"');
    expect(source).toContain("await withObjectRangeServer(");
  });

  it("does not use a signed GCS URL for a full long-game HLS build", () => {
    const hlsBuilder = source.slice(
      source.indexOf("export function ensureAllProxyChunksInBackground"),
      source.indexOf("// ---------------------------------------------------------------------------\\n// HLS build-completion sentinel"),
    );
    expect(hlsBuilder).not.toContain("getObjectEntitySignedURL");
  });
});