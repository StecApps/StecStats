import { ObjectStorageService } from "../src/lib/objectStorage";

// Parses Matroska/WebM cluster timecodes from head and tail byte ranges of a
// GCS object to determine the TRUE timeline of the video without downloading
// the whole file. Cluster ID = 0x1F43B675, Timecode element = 0xE7.
// Timecodes are in ms (default TimecodeScale 1_000_000 ns).

const OBJECT_PATH = process.argv[2] ?? "/objects/uploads/1/3922a1ee-e137-45d2-9d89-e5d356597c85";

function readVint(buf: Buffer, pos: number): { value: number; length: number } | null {
  if (pos >= buf.length) return null;
  const first = buf[pos];
  let mask = 0x80, length = 1;
  while (length <= 8 && !(first & mask)) { mask >>= 1; length++; }
  if (length > 8 || pos + length > buf.length) return null;
  let value = first & (mask - 1);
  for (let i = 1; i < length; i++) value = value * 256 + buf[pos + i];
  return { value, length };
}

function findClusterTimecodes(buf: Buffer, baseOffset: number): { fileOffset: number; timecodeMs: number }[] {
  const out: { fileOffset: number; timecodeMs: number }[] = [];
  for (let i = 0; i < buf.length - 16; i++) {
    if (buf[i] === 0x1f && buf[i + 1] === 0x43 && buf[i + 2] === 0xb6 && buf[i + 3] === 0x75) {
      // cluster header; skip size vint, then expect Timecode element 0xE7
      const size = readVint(buf, i + 4);
      if (!size) continue;
      let p = i + 4 + size.length;
      if (p >= buf.length - 10) continue;
      if (buf[p] !== 0xe7) continue; // Timecode should be first child
      const tcSize = readVint(buf, p + 1);
      if (!tcSize || tcSize.value > 8) continue;
      p = p + 1 + tcSize.length;
      if (p + tcSize.value > buf.length) continue;
      let tc = 0;
      for (let j = 0; j < tcSize.value; j++) tc = tc * 256 + buf[p + j];
      out.push({ fileOffset: baseOffset + i, timecodeMs: tc });
    }
  }
  return out;
}

function countEbmlHeaders(buf: Buffer): number {
  let n = 0;
  for (let i = 0; i < buf.length - 4; i++) {
    if (buf[i] === 0x1a && buf[i + 1] === 0x45 && buf[i + 2] === 0xdf && buf[i + 3] === 0xa3) n++;
  }
  return n;
}

async function readRange(file: any, start: number, end: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    file.createReadStream({ start, end })
      .on("data", (c: Buffer) => chunks.push(c))
      .on("end", () => resolve())
      .on("error", reject);
  });
  return Buffer.concat(chunks);
}

async function main() {
  const svc = new ObjectStorageService();
  const file = await svc.getObjectEntityFile(OBJECT_PATH);
  const [meta] = await file.getMetadata();
  const size = Number(meta.size);
  console.log(`object=${OBJECT_PATH} size=${size} (${(size / 1e9).toFixed(2)} GB)`);

  const HEAD = 4 * 1024 * 1024;
  const TAIL = 8 * 1024 * 1024;

  const head = await readRange(file, 0, Math.min(HEAD, size) - 1);
  console.log(`head EBML headers: ${countEbmlHeaders(head)}`);
  const headClusters = findClusterTimecodes(head, 0);
  console.log(`head clusters: ${headClusters.length}`);
  for (const c of headClusters.slice(0, 5))
    console.log(`  first clusters: offset=${c.fileOffset} tc=${(c.timecodeMs / 1000).toFixed(1)}s`);

  const tailStart = Math.max(0, size - TAIL);
  const tail = await readRange(file, tailStart, size - 1);
  const tailClusters = findClusterTimecodes(tail, tailStart);
  console.log(`tail clusters: ${tailClusters.length}`);
  for (const c of tailClusters.slice(-5))
    console.log(`  last clusters: offset=${c.fileOffset} tc=${(c.timecodeMs / 1000).toFixed(1)}s`);

  // Sample several midpoints to map byte offset -> timecode (detects
  // timeline discontinuities like a halftime recorder stall).
  for (const frac of [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875]) {
    const mid = Math.floor(size * frac);
    const buf = await readRange(file, mid, Math.min(mid + 3 * 1024 * 1024, size) - 1);
    const cs = findClusterTimecodes(buf, mid);
    const ebml = countEbmlHeaders(buf);
    if (cs.length > 0) {
      console.log(`byte ${(frac * 100).toFixed(1)}% (${(mid / 1e9).toFixed(2)} GB): tc=${(cs[0].timecodeMs / 1000).toFixed(1)}s  clusters=${cs.length} ebmlHeaders=${ebml}`);
    } else {
      console.log(`byte ${(frac * 100).toFixed(1)}%: NO clusters found in 3MB window (ebmlHeaders=${ebml})`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
