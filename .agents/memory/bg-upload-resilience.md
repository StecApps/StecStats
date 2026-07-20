---
name: Background upload resilience pattern
description: How IndexedDB session lifetime and localStorage markers keep game footage recoverable after a failed background upload.
---

# Background upload resilience

## The rule
The IndexedDB recording session must NOT be deleted before the background upload completes. Only delete it inside `onVideoReady` after the video is confirmed attached to the game in the database.

## Why
The previous pattern deleted the IDB session immediately on navigate-to-dashboard, before upload. If the upload failed (network error) the raw chunks were gone and there was no way to retry. A parent would lose footage of their kid's big game permanently.

## How to apply
In `record.tsx` background-upload path:
1. Capture `recordingSessionIdRef.current` into `capturedSessionId` BEFORE clearing it.
2. Write `stec:pending-video-upload` to localStorage: `{ gameId, opponent, sessionId, mimeType, savedAt }`.
3. Set `recordingSessionIdRef.current = null` but do NOT call `deleteSession`.
4. Inside the `onVideoReady` callback (runs only on success): call `deleteSession(capturedSessionId)` and `localStorage.removeItem(PENDING_VIDEO_UPLOAD_KEY)`.

On next app load, `PendingVideoUploadRecoverer` in `App.tsx`:
- Reads the localStorage marker.
- Checks if the game still has no video via `/api/games/:id`.
- Reassembles blob from IDB chunks via `getOrderedChunks`.
- Calls `backgroundUpload.start(...)` to retry automatically.

## Auto-retry
`backgroundUpload.ts` retries up to 3 times (4s, 8s backoff) on network errors before setting `status: 'failed'`. The banner shows a "Retry" button that re-runs the stored `doUpload`/`onVideoReady` closures (in-memory, not IDB).

## Key constant
`PENDING_VIDEO_UPLOAD_KEY = "stec:pending-video-upload"` — exported from `backgroundUpload.ts`, imported by both `record.tsx` and `App.tsx`.
