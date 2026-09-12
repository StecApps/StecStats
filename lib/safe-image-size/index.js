"use strict";

const fs = require("node:fs");

const MAX_INPUT_BYTES = 512 * 1024;

function assertRange(buffer, offset, length) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + length > buffer.length) {
    throw new TypeError("Corrupt image: unexpected end of input");
  }
}

function dimensions(width, height, type) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new TypeError(`Corrupt ${type.toUpperCase()}: invalid dimensions`);
  }
  return { width, height, type };
}

function parsePng(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)) return null;
  let offset = 8;
  for (let chunks = 0; chunks < 2; chunks += 1) {
    assertRange(buffer, offset, 8);
    const length = buffer.readUInt32BE(offset);
    const name = buffer.toString("ascii", offset + 4, offset + 8);
    if (name === "IHDR") {
      assertRange(buffer, offset + 8, 8);
      return dimensions(buffer.readUInt32BE(offset + 8), buffer.readUInt32BE(offset + 12), "png");
    }
    const next = offset + 12 + length;
    if (!Number.isSafeInteger(next) || next <= offset || next > buffer.length) {
      throw new TypeError("Corrupt PNG: invalid chunk length");
    }
    offset = next;
  }
  throw new TypeError("Corrupt PNG: missing IHDR");
}

function parseGif(buffer) {
  if (buffer.length < 10) return null;
  const signature = buffer.toString("ascii", 0, 6);
  if (signature !== "GIF87a" && signature !== "GIF89a") return null;
  return dimensions(buffer.readUInt16LE(6), buffer.readUInt16LE(8), "gif");
}

function parseBmp(buffer) {
  if (buffer.length < 26 || buffer.toString("ascii", 0, 2) !== "BM") return null;
  const dibSize = buffer.readUInt32LE(14);
  if (dibSize === 12) {
    return dimensions(buffer.readUInt16LE(18), buffer.readUInt16LE(20), "bmp");
  }
  assertRange(buffer, 18, 8);
  return dimensions(buffer.readInt32LE(18), Math.abs(buffer.readInt32LE(22)), "bmp");
}

function parseJpeg(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  let segments = 0;
  while (offset < buffer.length && segments < 65536) {
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    assertRange(buffer, offset, 1);
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0xd8 || marker === 0x01) continue;
    if (marker === 0xd9 || marker === 0xda) break;
    assertRange(buffer, offset, 2);
    const length = buffer.readUInt16BE(offset);
    if (length < 2) throw new TypeError("Corrupt JPEG: invalid segment length");
    const sof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (sof) {
      assertRange(buffer, offset + 2, 5);
      return dimensions(buffer.readUInt16BE(offset + 5), buffer.readUInt16BE(offset + 3), "jpg");
    }
    const next = offset + length;
    if (!Number.isSafeInteger(next) || next <= offset || next > buffer.length) {
      throw new TypeError("Corrupt JPEG: segment exceeds input");
    }
    offset = next;
    segments += 1;
  }
  throw new TypeError("Corrupt JPEG: no size marker found");
}

function parseWebp(buffer) {
  if (
    buffer.length < 30 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WEBP"
  ) {
    return null;
  }
  const chunk = buffer.toString("ascii", 12, 16);
  if (chunk === "VP8X") {
    return dimensions(buffer.readUIntLE(24, 3) + 1, buffer.readUIntLE(27, 3) + 1, "webp");
  }
  if (chunk === "VP8L") {
    assertRange(buffer, 20, 5);
    if (buffer[20] !== 0x2f) throw new TypeError("Corrupt WebP: invalid VP8L signature");
    const bits = buffer.readUInt32LE(21);
    return dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1, "webp");
  }
  if (chunk === "VP8 ") {
    assertRange(buffer, 26, 4);
    return dimensions(buffer.readUInt16LE(26) & 0x3fff, buffer.readUInt16LE(28) & 0x3fff, "webp");
  }
  throw new TypeError("Corrupt WebP: unsupported chunk");
}

function parseSvg(buffer) {
  const head = buffer.toString("utf8", 0, Math.min(buffer.length, 64 * 1024));
  if (!/<svg(?:\s|>)/i.test(head)) return null;
  const tag = head.match(/<svg\b[^>]*>/i)?.[0];
  if (!tag) throw new TypeError("Corrupt SVG: missing root tag");
  const width = Number(tag.match(/\bwidth\s*=\s*["']\s*([\d.]+)/i)?.[1]);
  const height = Number(tag.match(/\bheight\s*=\s*["']\s*([\d.]+)/i)?.[1]);
  if (width > 0 && height > 0) return dimensions(width, height, "svg");
  const viewBox = tag.match(/\bviewBox\s*=\s*["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)/i);
  if (viewBox) return dimensions(Number(viewBox[1]), Number(viewBox[2]), "svg");
  throw new TypeError("SVG requires width/height or a viewBox");
}

function parsePsd(buffer) {
  if (buffer.length < 4 || buffer.toString("ascii", 0, 4) !== "8BPS") return null;
  assertRange(buffer, 0, 26);
  const version = buffer.readUInt16BE(4);
  if (version !== 1 && version !== 2) throw new TypeError("Corrupt PSD: unsupported version");
  return dimensions(buffer.readUInt32BE(18), buffer.readUInt32BE(14), "psd");
}

function parseTiff(buffer) {
  if (buffer.length < 4) return null;
  const signature = buffer.toString("hex", 0, 4);
  if (signature !== "49492a00" && signature !== "4d4d002a") return null;
  const littleEndian = signature === "49492a00";
  const readUInt16 = littleEndian
    ? (offset) => buffer.readUInt16LE(offset)
    : (offset) => buffer.readUInt16BE(offset);
  const readUInt32 = littleEndian
    ? (offset) => buffer.readUInt32LE(offset)
    : (offset) => buffer.readUInt32BE(offset);
  assertRange(buffer, 4, 4);
  const ifdOffset = readUInt32(4);
  assertRange(buffer, ifdOffset, 2);
  const entryCount = readUInt16(ifdOffset);
  if (entryCount > Math.floor((buffer.length - ifdOffset - 2) / 12)) {
    throw new TypeError("Corrupt TIFF: directory exceeds input");
  }
  let width;
  let height;
  for (let index = 0; index < entryCount; index += 1) {
    const offset = ifdOffset + 2 + index * 12;
    assertRange(buffer, offset, 12);
    const tag = readUInt16(offset);
    const type = readUInt16(offset + 2);
    const count = readUInt32(offset + 4);
    if ((tag === 256 || tag === 257) && count === 1 && (type === 3 || type === 4)) {
      const value = type === 3 ? readUInt16(offset + 8) : readUInt32(offset + 8);
      if (tag === 256) width = value;
      else height = value;
    }
  }
  if (width === undefined || height === undefined) {
    throw new TypeError("Corrupt TIFF: missing dimensions");
  }
  return dimensions(width, height, "tiff");
}

function parseKtx(buffer) {
  const ktx1 = Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x31, 0x31, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ktx2 = Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 12) return null;
  if (buffer.subarray(0, 12).equals(ktx2)) {
    assertRange(buffer, 20, 8);
    return dimensions(buffer.readUInt32LE(20), buffer.readUInt32LE(24), "ktx2");
  }
  if (!buffer.subarray(0, 12).equals(ktx1)) return null;
  assertRange(buffer, 12, 32);
  const marker = buffer.readUInt32LE(12);
  if (marker === 0x04030201) {
    return dimensions(buffer.readUInt32LE(36), buffer.readUInt32LE(40), "ktx");
  }
  if (marker === 0x01020304) {
    return dimensions(buffer.readUInt32BE(36), buffer.readUInt32BE(40), "ktx");
  }
  throw new TypeError("Corrupt KTX: invalid endianness marker");
}

function lookup(input) {
  const buffer = Buffer.isBuffer(input)
    ? input
    : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  for (const parser of [
    parsePng,
    parseGif,
    parseBmp,
    parseJpeg,
    parseWebp,
    parseSvg,
    parsePsd,
    parseTiff,
    parseKtx,
  ]) {
    const result = parser(buffer);
    if (result) return result;
  }
  throw new TypeError("Unsupported image type");
}

function readPrefix(path) {
  const descriptor = fs.openSync(path, "r");
  try {
    const size = Math.min(fs.fstatSync(descriptor).size, MAX_INPUT_BYTES);
    if (size <= 0) throw new TypeError("Image cannot be empty");
    const buffer = Buffer.allocUnsafe(size);
    fs.readSync(descriptor, buffer, 0, size, 0);
    return buffer;
  } finally {
    fs.closeSync(descriptor);
  }
}

function imageSize(input, callback) {
  if (input instanceof Uint8Array) return lookup(input);
  if (typeof input !== "string") {
    throw new TypeError("Input must be a Uint8Array or file path");
  }
  if (typeof callback === "function") {
    fs.open(input, "r", (openError, descriptor) => {
      if (openError) return callback(openError);
      const buffer = Buffer.allocUnsafe(MAX_INPUT_BYTES);
      fs.read(descriptor, buffer, 0, buffer.length, 0, (readError, bytesRead) => {
        fs.close(descriptor, () => {});
        if (readError) return callback(readError);
        try {
          return callback(null, lookup(buffer.subarray(0, bytesRead)));
        } catch (error) {
          return callback(error);
        }
      });
    });
    return undefined;
  }
  return lookup(readPrefix(input));
}

module.exports = imageSize;
module.exports.default = imageSize;
module.exports.imageSize = imageSize;
module.exports.types = ["png", "gif", "bmp", "jpg", "webp", "svg", "psd", "tiff", "ktx", "ktx2"];