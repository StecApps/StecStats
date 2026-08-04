/**
 * uploadVideoFile
 *
 * Uploads a local video URI to object storage via a presigned PUT URL.
 *
 * iOS WebKit can suppress or fire xhr.upload.onprogress only once, so a
 * simulated progress ticker runs in parallel — it advances the bar visibly
 * using an asymptotic curve toward 90 %. Real XHR progress events win
 * whenever they report a higher value; the ticker is cleared on completion.
 */

export const UPLOAD_CANCELLED_MSG = 'Upload cancelled';

export async function uploadVideoFile(
  uri: string,
  requestUploadUrlFn: (body: { name: string; size: number; contentType: string }) => Promise<{ uploadURL: string; objectPath: string }>,
  onProgress?: (pct: number) => void,
  xhrRef?: { current: XMLHttpRequest | null },
  cancelToken?: { cancelled: boolean },
): Promise<string> {
  const fileResponse = await fetch(uri);
  const blob = await fileResponse.blob();
  // Check for cancellation after the potentially slow fetch+blob step.
  if (cancelToken?.cancelled) throw new Error(UPLOAD_CANCELLED_MSG);
  const contentType = uri.endsWith('.mov') ? 'video/quicktime' : 'video/mp4';
  const ext = uri.endsWith('.mov') ? 'mov' : 'mp4';
  const { uploadURL, objectPath } = await requestUploadUrlFn({
    name: `game-recording-${Date.now()}.${ext}`,
    size: blob.size || 1,
    contentType,
  });
  // Check again after the presign round-trip before opening the XHR.
  if (cancelToken?.cancelled) throw new Error(UPLOAD_CANCELLED_MSG);
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    if (xhrRef) xhrRef.current = xhr;
    // If cancel was requested between the check above and the XHR send, bail immediately.
    if (cancelToken?.cancelled) {
      if (xhrRef) xhrRef.current = null;
      reject(new Error(UPLOAD_CANCELLED_MSG));
      return;
    }
    xhr.open('PUT', uploadURL);
    xhr.setRequestHeader('Content-Type', contentType);

    // iOS WebKit can suppress or fire onprogress only once. Run a simulated
    // progress ticker so the bar always advances visibly. Real XHR events win
    // whenever they report a higher value; the ticker is cleared on completion.
    let reportedPct = 0;
    const TICK_MS = 300;
    // Asymptotic curve: each tick advances ~8 % of the remaining gap to 90 %.
    const CAP = 90;
    const simulatedTimer = onProgress
      ? setInterval(() => {
          if (reportedPct < CAP) {
            reportedPct = Math.min(CAP, reportedPct + Math.ceil((CAP - reportedPct) * 0.08));
            onProgress(reportedPct);
          }
        }, TICK_MS)
      : null;

    const finish = () => {
      if (simulatedTimer !== null) clearInterval(simulatedTimer);
      if (xhrRef) xhrRef.current = null;
    };

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        const real = Math.round((e.loaded / e.total) * 100);
        if (real > reportedPct) {
          reportedPct = real;
          onProgress(real);
        }
      }
    };
    xhr.onload = () => {
      finish();
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(100);
        resolve();
      } else {
        reject(new Error(`Video upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => { finish(); reject(new Error('Video upload failed (network error)')); };
    xhr.ontimeout = () => { finish(); reject(new Error('Video upload timed out')); };
    xhr.onabort = () => { finish(); reject(new Error(UPLOAD_CANCELLED_MSG)); };
    xhr.send(blob);
  });
  return objectPath;
}
