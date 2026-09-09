import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const routes = fs.readFileSync(path.resolve(__dirname, "../games.ts"), "utf8");

describe("reel HLS route contract", () => {
  it("binds completed VOD playlists to signed reel token claims", () => {
    expect(routes).toContain('streamType: type');
    expect(routes).toContain('isHls: true');
    expect(routes).toContain('hlsSegmentCount: info.segmentCount');
    expect(routes).toContain('segmentToken = signStreamToken(segmentEntry)');
    expect(routes).toContain('segment/${i}?t=${segmentToken}');
    expect(routes).toContain('"#EXT-X-PLAYLIST-TYPE:VOD"');
    expect(routes).toContain('lines.push("#EXT-X-ENDLIST")');
    expect(routes).toContain('const isReel = entry.streamType === "highlight" || entry.streamType === "lowlight"');
    expect(routes).toContain('? entry.objectPath');
  });

  it("keeps reel token issuance free of source download/probe work", () => {
    const tokenRoute = routes.slice(
      routes.indexOf('router.get("/games/:gameId/stream-token/:type"'),
      routes.indexOf('/**\n * GET /games/:gameId/stream/:type'),
    );
    const reelIssuance = tokenRoute.slice(
      tokenRoute.indexOf('if (type === "highlight" || type === "lowlight")'),
      tokenRoute.indexOf('// Pre-generate the GCS signed URL'),
    );
    expect(reelIssuance).not.toContain("getReelHlsInfo");
    expect(reelIssuance).not.toContain("acquireReelHlsSource");
    expect(routes).toContain("const info = await getReelHlsInfo(entry.objectPath)");
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