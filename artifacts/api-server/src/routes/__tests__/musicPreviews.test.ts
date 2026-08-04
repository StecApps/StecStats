/**
 * Music preview endpoint integration tests — Task 208
 *
 * Mounts the real music router against a live http.Server so the full
 * Express routing + sendFile pipeline is exercised without needing a running
 * server or camera access.
 *
 * Covers:
 *   1. GET /api/music/tracks — all six entries report hasPreview: true
 *   2. GET /api/music/tracks/:id/preview — cinematic, oldschool, and lofi
 *      each return 200, Content-Type: audio/mpeg, and a non-empty body
 *   3. GET /api/music/tracks/:id/preview for all six tracks (regression guard)
 *   4. Unknown track ID returns 404
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";

import musicRouter from "../music";

// ---------------------------------------------------------------------------
// Test server setup
// ---------------------------------------------------------------------------

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use("/api", musicRouter);

  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/api`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// Suite 1 — GET /api/music/tracks
// ---------------------------------------------------------------------------

describe("GET /api/music/tracks", () => {
  it("returns 200 with an array of six tracks", async () => {
    const res = await fetch(`${baseUrl}/music/tracks`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body).toHaveLength(6);
  });

  it("every track in the list has hasPreview: true", async () => {
    const res = await fetch(`${baseUrl}/music/tracks`);
    const body = (await res.json()) as Array<{
      id: string;
      label: string;
      hasPreview: boolean;
    }>;
    const withoutPreview = body.filter((t) => t.hasPreview !== true);
    expect(
      withoutPreview,
      `Tracks missing hasPreview: true → [${withoutPreview.map((t) => t.id).join(", ")}]. ` +
        "Check that the MP3 file exists in api-server/src/assets/music/.",
    ).toHaveLength(0);
  });

  it("the six expected track IDs are all present", async () => {
    const res = await fetch(`${baseUrl}/music/tracks`);
    const body = (await res.json()) as Array<{ id: string }>;
    const ids = body.map((t) => t.id).sort();
    expect(ids).toEqual(
      ["cinematic", "dynamic", "energetic", "lofi", "oldschool", "upbeat"],
    );
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — GET /api/music/tracks/:id/preview for the three new tracks
// ---------------------------------------------------------------------------

describe("GET /api/music/tracks/:id/preview — new tracks (cinematic, oldschool, lofi)", () => {
  const NEW_TRACKS = ["cinematic", "oldschool", "lofi"] as const;

  for (const trackId of NEW_TRACKS) {
    it(`${trackId}: returns 200 with Content-Type audio/mpeg`, async () => {
      const res = await fetch(`${baseUrl}/music/tracks/${trackId}/preview`);
      expect(
        res.status,
        `Expected 200 for ${trackId} but got ${res.status}. ` +
          `Verify that ${trackId}.mp3 is present in api-server/src/assets/music/.`,
      ).toBe(200);
      expect(
        res.headers.get("content-type"),
        `Expected audio/mpeg Content-Type for ${trackId}`,
      ).toMatch(/audio\/mpeg/);
    });

    it(`${trackId}: response body is non-empty (file has content)`, async () => {
      const res = await fetch(`${baseUrl}/music/tracks/${trackId}/preview`);
      const buf = await res.arrayBuffer();
      expect(
        buf.byteLength,
        `${trackId}.mp3 was served but the body was empty — the file may be a stub.`,
      ).toBeGreaterThan(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Suite 3 — regression guard: all six tracks serve valid audio
// ---------------------------------------------------------------------------

describe("GET /api/music/tracks/:id/preview — all six tracks", () => {
  const ALL_TRACKS = [
    "energetic",
    "upbeat",
    "dynamic",
    "cinematic",
    "oldschool",
    "lofi",
  ] as const;

  for (const trackId of ALL_TRACKS) {
    it(`${trackId}: 200 + audio/mpeg + non-empty body`, async () => {
      const res = await fetch(`${baseUrl}/music/tracks/${trackId}/preview`);
      expect(res.status, `${trackId} preview returned ${res.status}`).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/audio\/mpeg/);
      const buf = await res.arrayBuffer();
      expect(buf.byteLength, `${trackId}.mp3 body is empty`).toBeGreaterThan(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Suite 4 — unknown track ID returns 404
// ---------------------------------------------------------------------------

describe("GET /api/music/tracks/:id/preview — unknown id", () => {
  it("returns 404 for an unrecognised track id", async () => {
    const res = await fetch(`${baseUrl}/music/tracks/nonexistent/preview`);
    expect(res.status).toBe(404);
  });
});
