export async function uploadVideoBlob(blob: Blob, onProgress?: (pct: number) => void): Promise<string> {
  const requestRes = await fetch("/api/storage/uploads/request-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: `game-recording-${Date.now()}.webm`,
      size: blob.size,
      contentType: blob.type || "video/webm",
    }),
  });
  if (!requestRes.ok) throw new Error("Failed to request upload URL");
  const { uploadURL, objectPath } = await requestRes.json();

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadURL);
    xhr.setRequestHeader("Content-Type", blob.type || "video/webm");
    xhr.timeout = 90 * 60 * 1000;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Network error during upload — check your connection and try again"));
    xhr.ontimeout = () => reject(new Error("Upload timed out — video may be too large for your current connection"));
    xhr.send(blob);
  });

  return objectPath as string;
}
