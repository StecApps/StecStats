"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const imageSize = require("./index");

function makeFixtures() {
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.writeUInt32BE(13, 8);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(32, 16);
  png.writeUInt32BE(24, 20);

  const gif = Buffer.alloc(10);
  gif.write("GIF89a", 0, "ascii");
  gif.writeUInt16LE(32, 6);
  gif.writeUInt16LE(24, 8);

  const bmp = Buffer.alloc(26);
  bmp.write("BM", 0, "ascii");
  bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(32, 18);
  bmp.writeInt32LE(24, 22);

  const jpg = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x07, 0x08, 0x00, 0x18, 0x00, 0x20,
  ]);

  const webp = Buffer.alloc(30);
  webp.write("RIFF", 0, "ascii");
  webp.write("WEBP", 8, "ascii");
  webp.write("VP8X", 12, "ascii");
  webp.writeUIntLE(31, 24, 3);
  webp.writeUIntLE(23, 27, 3);

  const svg = Buffer.from('<svg width="32" height="24"></svg>');

  const psd = Buffer.alloc(26);
  psd.write("8BPS", 0, "ascii");
  psd.writeUInt16BE(1, 4);
  psd.writeUInt32BE(24, 14);
  psd.writeUInt32BE(32, 18);

  const tiff = Buffer.alloc(38);
  tiff.write("II", 0, "ascii");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(2, 8);
  tiff.writeUInt16LE(256, 10);
  tiff.writeUInt16LE(4, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt32LE(32, 18);
  tiff.writeUInt16LE(257, 22);
  tiff.writeUInt16LE(4, 24);
  tiff.writeUInt32LE(1, 26);
  tiff.writeUInt32LE(24, 30);

  const ktx = Buffer.alloc(44);
  Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x31, 0x31, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]).copy(ktx);
  ktx.writeUInt32LE(0x04030201, 12);
  ktx.writeUInt32LE(32, 36);
  ktx.writeUInt32LE(24, 40);

  return { png, jpg, jpeg: jpg, bmp, gif, webp, psd, svg, tiff, ktx };
}

test("reads the dimensions of the app's PNG assets", () => {
  const logo = path.resolve(__dirname, "../../artifacts/hoops-mobile/assets/images/logo.png");
  const result = imageSize(fs.readFileSync(logo));
  assert.equal(result.type, "png");
  assert.ok(result.width > 0);
  assert.ok(result.height > 0);
});

for (const [extension, fixture] of Object.entries(makeFixtures())) {
  test(`reads a valid Metro ${extension} asset`, () => {
    assert.deepEqual(
      { width: imageSize(fixture).width, height: imageSize(fixture).height },
      { width: 32, height: 24 },
    );
  });

  test(`rejects a truncated Metro ${extension} asset`, () => {
    assert.throws(() => imageSize(fixture.subarray(0, Math.max(1, Math.floor(fixture.length / 2)))));
  });
}

test("rejects the vulnerable ICNS zero-length loop input", () => {
  const input = Buffer.alloc(16);
  input.write("icns", 0, "ascii");
  input.writeUInt32BE(16, 4);
  input.write("TEST", 8, "ascii");
  input.writeUInt32BE(0, 12);
  assert.throws(() => imageSize(input), /Unsupported image type/);
});

test("rejects the vulnerable HEIF zero-length box input", () => {
  const input = Buffer.alloc(24);
  input.writeUInt32BE(24, 0);
  input.write("ftyp", 4, "ascii");
  input.write("heic", 8, "ascii");
  input.writeUInt32BE(0, 16);
  input.write("ispe", 20, "ascii");
  assert.throws(() => imageSize(input), /Unsupported image type/);
});

test("rejects non-advancing JPEG segments", () => {
  const input = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00]);
  assert.throws(() => imageSize(input), /invalid segment length/);
});