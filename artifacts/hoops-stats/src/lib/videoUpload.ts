export async function uploadVideoBlob(
  blob: Blob,
  onProgress?: (pct: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new Error("Upload cancelled");

  const requestRes = await fetch("/api/storage/uploads/request-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: `game-recording-${Date.now()}.webm`,
      size: blob.size,
      contentType: blob.type || "video/webm",
    }),
    signal,
  });
  if (!requestRes.ok) throw new Error("Failed to request upload URL");
  const { uploadURL, objectPath } = await requestRes.json();

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadURL);
    xhr.setRequestHeader("Content-Type", blob.type || "video/webm");
    // 10 minutes is plenty for any game recording on a working connection.
    // The old 90-minute value caused uploads to hang silently for 1.5 h when
    // the gym network dropped. 10 min surfaces the failure quickly enough for
    // the user to move somewhere with better signal and tap Retry.
    xhr.timeout = 10 * 60 * 1000;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Network error — check your connection and tap Retry"));
    xhr.ontimeout = () => reject(new Error("Upload timed out — move to a stronger signal and tap Retry"));

    // Hook the AbortSignal so a user-initiated cancel aborts the XHR immediately
    // rather than waiting for the 10-minute timeout.
    const onAbort = () => {
      xhr.abort();
      reject(new Error("Upload cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    xhr.onloadend = () => signal?.removeEventListener("abort", onAbort);

    xhr.send(blob);
  });

  return objectPath as string;
}
