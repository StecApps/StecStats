---
name: Recording save race condition — blob assembly vs handleSave
description: Pressing Stop then Save quickly can save a game with no video because the IndexedDB blob assembly is async and recordedBlob is still null when handleSave runs.
---

# Recording save race condition

## The rule
`stopRecording()` → `recorder.stop()` → `recorder.onstop` fires **asynchronously** after MediaRecorder finishes encoding and IndexedDB reads complete.  `recordedBlob` state is still `null` at the moment `stopRecording` returns.  If the user taps "Save Game" before `onstop` finishes, `handleSave` sees `isRecording=false` (already set) and `recordedBlob=null` → skips the upload entirely → game is saved with no `videoObjectPath`.

**Why:** Confirmed via production logs: the `POST /api/games` request fired ~33 seconds after the live session ended with **no presigned URL or upload request between them** — the classic symptom of `blobToUpload` being null at save time.

**How to apply:**
- Whenever you touch the recording stop path, ensure a `blobAssemblyPromiseRef` (or equivalent) captures the `Promise<Blob|null>` started by `onstop`.
- In `handleSave`, after the `if (isRecording)` branch, add an `else if (!blobToUpload && blobAssemblyPromiseRef.current)` branch that `await`s the pending assembly before attempting the upload.
- Do NOT rely on `recordedBlob` state alone — React state updates are async and are not guaranteed to be visible on the next synchronous tick after `setRecordedBlob(blob)`.
- `stopRecordingAsync` (the in-recording save path) already awaits correctly; the bug only manifests in the stop-then-save flow where `isRecording=false` at the time `handleSave` is called.
