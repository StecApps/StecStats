import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { planProxyChunkBuild } from "../reelChunkPlan";

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

  it("yields the global ffmpeg queue between bounded HLS batches", () => {
    const hlsBuilder = source.slice(
      source.indexOf("export function ensureAllProxyChunksInBackground"),
      source.indexOf("// ---------------------------------------------------------------------------\\n// HLS build-completion sentinel"),
    );
    expect(hlsBuilder).toContain("HLS_FFMPEG_BATCH_DURATION_SEC");
    expect(hlsBuilder).toContain("while (true)");
    expect(hlsBuilder).toContain("batch.actualNumChunks === nextMissing");
  });

  it("uses fast pre-input seeking for the authenticated loopback source", () => {
    expect(source).toContain("isSeekableLoopbackSource");
    expect(source).toContain("useFastInputSeek");
    expect(source).toContain('"Proxy: ffmpeg media clock advancing"');
    expect(source).toContain("stallTimeoutMs: 5 * 60 * 1000");
    expect(source).toContain("niceLevel: chunkPathFactory ? 10 : 0");
  });

  it("also streams targeted long-game reel chunks without downloading the full master", () => {
    const targetedChunkBuilder = source.slice(
      source.indexOf("async function doEnsureProxyChunksInGcs"),
      source.indexOf("const proxyLocalCache"),
    );
    expect(targetedChunkBuilder).toContain(
      "maxChunkNeeded == null && durSec > MAX_INLINE_FULL_PROXY_DURATION_SEC",
    );
    expect(targetedChunkBuilder).toContain("await withObjectRangeServer(");
    expect(targetedChunkBuilder).toContain("game.videoObjectPath");
    expect(targetedChunkBuilder).not.toContain(
      "effectiveDurSec > MAX_INLINE_PROXY_DURATION_SEC",
    );
  });

  it("never falls a long reel back to a full tmpfs master download", () => {
    const highlightGenerator = source.slice(
      source.indexOf("export async function generateHighlight"),
      source.indexOf("export async function generateLowlight"),
    );
    const lowlightGenerator = source.slice(
      source.indexOf("export async function generateLowlight"),
      source.indexOf("export async function generateTeamHighlight"),
    );
    expect(highlightGenerator).toContain(
      "highlightChunksConfirmed || rawSourceFallbackIsUnsafe(game)",
    );
    expect(lowlightGenerator).toContain(
      "lowlightChunksConfirmed || rawSourceFallbackIsUnsafe(game)",
    );
  });

  it("does no work when the targeted range and boundary headroom already exist", () => {
    expect(planProxyChunkBuild(
      [true, true, true, true, true, true, false],
      4,
    )).toEqual({
      requiredChunkCount: 6,
      firstMissing: -1,
    });
  });

  it("ignores missing chunks after the targeted boundary headroom", () => {
    expect(planProxyChunkBuild(
      [true, true, true, true, false, true, false],
      4,
    )).toEqual({
      requiredChunkCount: 6,
      firstMissing: 4,
    });
  });

  it("stops same-game HLS encoding while a reel owns the media worker", () => {
    expect(source).toContain("activeReelGames.add(gameId)");
    expect(source).toContain("cancelHlsBuild(gameId)");
    expect(source).toContain("activeReelGames.has(gameId)");
    expect(source).toContain(
      "if (reelMarkedActive) activeReelGames.delete(gameId)",
    );
  });
});