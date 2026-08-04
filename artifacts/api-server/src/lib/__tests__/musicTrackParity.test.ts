/**
 * Music track parity test.
 *
 * The client's track catalogue lives in
 *   artifacts/hoops-stats/src/components/MusicTrackSelector.tsx
 * and the server's lives in
 *   artifacts/api-server/src/lib/musicTracks.ts
 *
 * They are in separate packages and cannot share code directly, so they can
 * drift silently: a developer adds a track to the UI selector and forgets the
 * server list, causing the server to ignore the musicTrack body param and
 * generate reels with no music.
 *
 * This test fails loudly whenever the two lists diverge.
 *
 * Approach: read MusicTrackSelector.tsx as plain text (to avoid importing
 * React/JSX) and extract the IDs with a regex, then compare against the
 * typed server list.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

import { MUSIC_TRACKS as SERVER_TRACKS } from "../musicTracks";

// ── locate the client file relative to this test ─────────────────────────────
// __dirname = artifacts/api-server/src/lib/__tests__
// repo root  = ../../../../..
const CLIENT_FILE = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "artifacts",
  "hoops-stats",
  "src",
  "components",
  "MusicTrackSelector.tsx",
);

// ── extract IDs from source text ──────────────────────────────────────────────
/**
 * Parse every `{ id: "…"` entry inside the MUSIC_TRACKS array literal in the
 * source text.  We intentionally read the raw source rather than eval/import
 * it so we avoid pulling in React/JSX into the test environment.
 *
 * The regex matches: `{ id: "someId"` (with any surrounding whitespace).
 * It captures the string between the double-quotes after `id:`.
 */
function extractClientTrackIds(source: string): string[] {
  // Find the MUSIC_TRACKS array block so we only scan within it.
  const arrayStart = source.indexOf("export const MUSIC_TRACKS");
  const arrayEnd   = source.indexOf("] as const;", arrayStart);
  if (arrayStart === -1 || arrayEnd === -1) {
    throw new Error(
      "Could not locate `export const MUSIC_TRACKS … ] as const;` in MusicTrackSelector.tsx. " +
      "If the variable was renamed, update this test to match.",
    );
  }

  const block = source.slice(arrayStart, arrayEnd);
  const ids: string[] = [];
  const re = /\bid:\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    ids.push(m[1]);
  }
  return ids;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("music track parity — client selector vs server list", () => {
  let clientIds: string[];
  let serverIds: string[];

  // Parse once, share across it() blocks.
  try {
    const source = readFileSync(CLIENT_FILE, "utf8");
    clientIds = extractClientTrackIds(source);
  } catch (err) {
    // Surface parse errors as a failing assertion instead of a test-setup crash.
    clientIds = [];
  }

  serverIds = SERVER_TRACKS.map((t) => t.id);

  it("client MusicTrackSelector.tsx was parsed and contains at least one track", () => {
    expect(clientIds.length).toBeGreaterThan(0);
  });

  it("every client track ID is recognised by the server", () => {
    const missing = clientIds.filter((id) => !serverIds.includes(id));
    expect(
      missing,
      `Track(s) present in MusicTrackSelector.tsx but MISSING from api-server/src/lib/musicTracks.ts: ` +
      `[${missing.join(", ")}]. ` +
      `Add them to musicTracks.ts so the server can mix them into reels.`,
    ).toHaveLength(0);
  });

  it("every server track ID is present in the client selector", () => {
    const missing = serverIds.filter((id) => !clientIds.includes(id));
    expect(
      missing,
      `Track(s) present in api-server/src/lib/musicTracks.ts but MISSING from MusicTrackSelector.tsx: ` +
      `[${missing.join(", ")}]. ` +
      `Add them to MusicTrackSelector.tsx so coaches can select them.`,
    ).toHaveLength(0);
  });

  it("client and server have identical track IDs (order-independent)", () => {
    expect([...clientIds].sort()).toEqual([...serverIds].sort());
  });
});
