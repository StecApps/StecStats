---
name: GCS signed URLs reject appended query params
description: Appending response-content-type/-disposition to a sidecar-signed GCS V4 URL always 403s; patch object metadata instead.
---

Rule: never append query parameters (e.g. `response-content-type`, `response-content-disposition`) to a GCS signed URL after signing. V4 signatures cover ALL query params, so any addition returns `403 SignatureDoesNotMatch` — the media element then shows `MEDIA_ERR_SRC_NOT_SUPPORTED`, which looks like a codec problem but is an HTTP failure.

**Why:** The Replit sidecar signing endpoint (`/object-storage/signed-object-url`) only accepts bucket/object/method/expiry — it cannot include response-override params in the signature. This bug shipped to production once ("Ensure videos play correctly by setting the proper content type") and silently broke film-room playback and named reel downloads.

**How to apply:** To control served `Content-Type` or `Content-Disposition`, PATCH the object's metadata once via the SDK (`objectFile.setMetadata({...})` — works fine with the sidecar-authenticated client), then return the bare signed URL. Persistent `contentDisposition: attachment` on a video object is safe: browsers ignore Content-Disposition for `<video>` elements and `fetch()`; it only affects navigations/downloads.
