import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const routes = fs.readFileSync(path.resolve(__dirname, "../games.ts"), "utf8");
const generator = fs.readFileSync(path.resolve(__dirname, "../../lib/highlightGenerator.ts"), "utf8");
const derivatives = fs.readFileSync(path.resolve(__dirname, "../../lib/highlightDerivatives.ts"), "utf8");

describe("reel HLS route contract", () => {
  it("binds completed VOD playlists to signed reel token claims", () => {
    expect(routes).toContain('streamType: type');
    expect(routes).toContain('isHls: true');
    expect(routes).toContain('hlsSegmentCount: manifest.segments.length');
    expect(routes).toContain('segmentToken = signStreamToken(segmentEntry)');
    expect(routes).toContain('segment/${i}?t=${segmentToken}');
    expect(routes).toContain('"#EXT-X-PLAYLIST-TYPE:VOD"');
    expect(routes).toContain('lines.push("#EXT-X-ENDLIST")');
    expect(routes).toContain("...manifest.segments.map((segment) => segment.durationSec)");
    expect(routes).toContain("`#EXT-X-TARGETDURATION:${targetDuration}`");
    expect(routes).toContain('res.end(`${lines.join("\\n")}\\n`)');
    expect(routes).toContain('const isReel = entry.streamType === "highlight" || entry.streamType === "lowlight"');
    expect(routes).toContain("readReelHlsManifest(entry.objectPath)");
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
    expect(reelIssuance).not.toContain("readReelHlsManifest");
    expect(routes).toContain("const manifest = await readReelHlsManifest(entry.objectPath)");
  });

  it("serves pre-generated independently decodable reel segments directly", () => {
    expect(routes).toContain("const reelManifest = isReel ? await readReelHlsManifest(entry.objectPath) : null");
    expect(routes).toContain("reelManifest!.segments[chunkIndex]!.objectPath");
    expect(routes).toContain("createReadStream(chunk.localPath).pipe(res)");
    expect(routes).not.toContain('"-ss", String(chunkIndex * entry.hlsSegmentDurationSec!)');
  });

  it("binds segment access to the stored manifest and finite playlist token", () => {
    expect(routes).toContain("hlsSegmentCount: manifest.segments.length");
    expect(routes).toContain("reelManifest.segments.length !== entry.hlsSegmentCount");
  });

  it("builds and publishes the complete VOD derivative before reel readiness", () => {
    expect(generator).toContain('"-hls_playlist_type", "vod"');
    expect(generator).toContain('"-hls_time", String(REEL_HLS_SEGMENT_DURATION_SEC)');
    expect(generator).toContain("await buildAndUploadReelHls(outPath, objectPath");
    expect(generator).toContain("reelHlsManifestPath(combinedPath)");
    expect(derivatives).toContain("deleteObjectEntityPrefix(reelHlsPrefix(combinedPath))");
  });
});
