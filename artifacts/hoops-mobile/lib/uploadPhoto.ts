/**
 * uploadPhoto — pure async function, no React-Native / Expo imports.
 *
 * Accepting apiBase as a parameter removes any dependency on
 * babel-preset-expo's process.env injection (expo/virtual/env.js) so
 * the file can be unit-tested in a plain Node Jest environment.
 */
export async function uploadPhoto(
  uri: string,
  mimeType: string,
  token: string,
  apiBase: string = '',
): Promise<string> {
  let reqRes: Response;
  try {
    reqRes = await fetch(`${apiBase}/api/storage/uploads/request-url`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        name: `player-photo-${Date.now()}.jpg`,
        size: 0,
        contentType: mimeType || 'image/jpeg',
      }),
    });
  } catch {
    throw new Error('Network error — check your connection and try again.');
  }

  if (reqRes.status === 401 || reqRes.status === 403) {
    throw new Error('Not authorised — please sign out and back in, then try again.');
  }
  if (!reqRes.ok) {
    throw new Error(`Server error (${reqRes.status}) — please try again.`);
  }

  const { uploadURL, objectPath } = await reqRes.json();

  let blob: Blob;
  try {
    blob = await (await fetch(uri)).blob();
  } catch {
    throw new Error('Could not read the photo — please try a different image.');
  }

  let upRes: Response;
  try {
    upRes = await fetch(uploadURL, {
      method: 'PUT',
      headers: { 'Content-Type': mimeType || 'image/jpeg' },
      body: blob,
    });
  } catch {
    throw new Error('Network error during upload — check your connection and try again.');
  }
  if (!upRes.ok) {
    throw new Error(`Upload failed (${upRes.status}) — please try again.`);
  }

  return objectPath;
}
