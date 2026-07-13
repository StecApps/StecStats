---
name: GCS signed-URL range requests unreliable in production
description: Replit sidecar-signed URLs return garbage bytes for mid-file byte-range requests; use GCS SDK createReadStream instead.
---

## Rule
Never use `fetch(signedUrl, { headers: { Range: "bytes=X-Y" } })` for mid-file reads in the production deployment environment. The bytes returned are garbage (not the actual file content at that offset).

## Why
The Replit sidecar at `http://127.0.0.1:1106/object-storage/signed-object-url` generates GCS V4 signed URLs. In the production container these URLs appear to return incorrect bytes for non-zero range requests — the response is 200/206 with the right length but wrong content (possibly served from byte 0 regardless of the Range header, or decoded differently).

This caused an MP4 box scan to read e.g. `boxType="?B??"` at offset 0 instead of `"ftyp"`, making the multi-segment detector always return null.

**How to apply:** Use the GCS Node.js SDK's `file.createReadStream({ start, end })` for any range read. This uses service-account authentication (not signed URLs) and always returns the correct bytes. Obtain the `File` object via `objectStorageService.getObjectEntityFile(objectPath)` and pass it around instead of a signed URL string.

Full-file downloads via signed URL (`Range: bytes=0-`) work fine (GCS returns 200 with the whole file body). Only mid-file partial ranges are unreliable via signed URL in prod.
