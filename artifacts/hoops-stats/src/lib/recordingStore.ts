// Durable, disk-backed storage for in-progress game recordings.
//
// MediaRecorder chunks used to be buffered in a plain in-memory array for the
// entire session and only combined into one Blob at the very end. For long
// games (45-60+ min) at a few Mbps that's multiple gigabytes sitting in the
// JS heap, which reliably OOM-crashes mobile browser tabs (observed as a
// white screen) and takes the whole recording + unsaved stats down with it.
//
// IndexedDB-backed Blobs are stored on disk by the browser, not held in
// memory, so writing each timesliced chunk here as it arrives keeps heap
// usage roughly flat regardless of recording length. It also means the raw
// video survives a tab crash/reload — recovery UI can reopen this DB by
// session id and reassemble the Blob.

const DB_NAME = "stec-recording-store";
const DB_VERSION = 1;
const STORE_NAME = "chunks";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: ["sessionId", "seq"] });
        store.createIndex("sessionId", "sessionId", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export function createRecordingSessionId(): string {
  return `rec-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function saveChunk(sessionId: string, seq: number, blob: Blob): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put({ sessionId, seq, blob });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getOrderedChunks(sessionId: string): Promise<Blob[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const index = tx.objectStore(STORE_NAME).index("sessionId");
    const range = IDBKeyRange.only(sessionId);
    const results: { seq: number; blob: Blob }[] = [];
    const cursorReq = index.openCursor(range);
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        results.push(cursor.value);
        cursor.continue();
      } else {
        results.sort((a, b) => a.seq - b.seq);
        resolve(results.map((r) => r.blob));
      }
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
}

export async function hasChunks(sessionId: string): Promise<boolean> {
  try {
    const chunks = await getOrderedChunks(sessionId);
    return chunks.length > 0;
  } catch {
    return false;
  }
}

export async function deleteSession(sessionId: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const index = tx.objectStore(STORE_NAME).index("sessionId");
    const range = IDBKeyRange.only(sessionId);
    const cursorReq = index.openCursor(range);
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
