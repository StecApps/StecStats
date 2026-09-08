import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const routes = fs.readFileSync(path.resolve(__dirname, "../games.ts"), "utf8");

describe("reel HLS route contract", () => {
  it("binds completed VOD playlists to signed reel token claims", () => {
    expect(routes).toContain('streamType: type');
    expect(routes).toContain('isHls: true');
    expect(routes).toContain('hlsSegmentCount: hlsInfo.segmentCount');
    expect(routes).toContain('"#EXT-X-PLAYLIST-TYPE:VOD"');
    expect(routes).toContain('lines.push("#EXT-X-ENDLIST")');
    expect(routes).toContain('const isReel = entry.streamType === "highlight" || entry.streamType === "lowlight"');
    expect(routes).toContain('? entry.objectPath');
  });

  it("uses an accurate bounded re-encode for independently decodable reel segments", () => {
    expect(routes).toContain('"-i", chunk.localPath');
    expect(routes).toContain('"-ss", String(chunkIndex * entry.hlsSegmentDurationSec!)');
    expect(routes).toContain('"-t", String(reelSegmentDuration)');
    expect(routes).toContain('"-c:v", "libx264"');
    expect(routes).not.toContain('"-bf", "0"');
  });

  it("keeps a bounded idle local source cache across sequential segments", () => {
    expect(routes).toContain("const REEL_HLS_LOCAL_CACHE_MAX = 3");
    expect(routes).toContain("const REEL_HLS_LOCAL_CACHE_TTL_MS = 10 * 60_000");
    expect(routes).toContain("async function acquireReelHlsSource");
    expect(routes).toContain("candidate.users === 0");
  });
});