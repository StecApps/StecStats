import AsyncStorage from '@react-native-async-storage/async-storage';
import { File } from 'expo-file-system';
import * as FileSystem from 'expo-file-system/legacy';
import { FileSystemSessionType } from 'expo-file-system/legacy';
import { fetch as expoFetch } from 'expo/fetch';
import NetInfo, { type NetInfoStateType } from '@react-native-community/netinfo';
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { Platform } from 'react-native';

export type ReelType = 'highlight' | 'lowlight';
export type ReelDownloadStatus = 'queued' | 'downloading' | 'downloaded' | 'failed';
export type ReelDownload = {
  gameId: number;
  type: ReelType;
  objectPath: string;
  url: string;
  status: ReelDownloadStatus;
  uri?: string;
  error?: string;
  requestedAt: number;
  priority?: number;
  sizeBytes?: number;
  expectedBytes?: number;
  expectedMd5?: string;
  bytesWritten?: number;
  resumeData?: string;
  needsUrlRefresh?: boolean;
};

type Listener = () => void;
const MIN_COMPLETE_BYTES = 1024;
// Some production range proxies close a response which remains open for an
// entire reel. Keep every iOS request comfortably below those limits.
const IOS_RANGE_CHUNK_BYTES = 2 * 1024 * 1024;
// v1 wrote an active download directly into the final .mp4 path. AVPlayer
// could therefore open a truncated file and keep reporting only its first few
// seconds even after the transfer changed underneath it. Start clean once.
const MANIFEST_PREFIX = '@stecstats/reel-downloads/v5/';
const OBSOLETE_MANIFEST_PREFIXES = [
  '@stecstats/reel-downloads/v1/',
  '@stecstats/reel-downloads/v2/',
  '@stecstats/reel-downloads/v3/',
  '@stecstats/reel-downloads/v4/',
];
const PREFERENCE_KEY = '@stecstats/reel-downloads/cellular';
const REEL_STORAGE_ROOT = FileSystem.documentDirectory ?? FileSystem.cacheDirectory;

function hash(value: string) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) { h ^= value.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
function key(gameId: number, type: ReelType, objectPath: string) {
  return `${gameId}:${type}:${objectPath}`;
}

export class ReelDownloadManager {
  private accountId: string | null = null;
  private entries = new Map<string, ReelDownload>();
  private tasks = new Map<string, ReturnType<typeof FileSystem.createDownloadResumable>>();
  private controllers = new Map<string, AbortController>();
  private generations = new Map<string, number>();
  private listeners = new Set<Listener>();
  private active = 0;
  private readonly concurrency = 2;
  private cellularAllowed = false;
  private networkType: NetInfoStateType | 'unknown' = 'unknown';
  private connected = false;
  private unsubscribeNetwork: (() => void) | null = null;
  private activationChain: Promise<void> = Promise.resolve();
  // AsyncStorage writes are asynchronous native operations. Without ordering,
  // an older "downloading" snapshot can finish after the completion snapshot
  // and make a valid reel look interrupted on the next launch.
  private persistenceChain: Promise<void> = Promise.resolve();

  private manifestKey() { return `${MANIFEST_PREFIX}${this.accountId}`; }
  private uriFor(entry: Pick<ReelDownload, 'gameId' | 'type' | 'objectPath'>) {
    // The account directory prevents one coach's file URI being handed to another.
    // Reels are user-requested offline media, not disposable cache data. Keeping
    // them in Documents prevents iOS from purging a file between download and play.
    return `${REEL_STORAGE_ROOT}reels/${hash(this.accountId ?? 'signed-out')}/${entry.type}-${entry.gameId}-${hash(entry.objectPath)}.mp4`;
  }
  private partialUriFor(entry: Pick<ReelDownload, 'gameId' | 'type' | 'objectPath'>) {
    return `${this.uriFor(entry)}.part`;
  }
  private emit() { this.listeners.forEach((listener) => listener()); }
  subscribe(listener: Listener) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  snapshot() { return [...this.entries.values()]; }
  get(gameId: number, type: ReelType, objectPath: string) { return this.entries.get(key(gameId, type, objectPath)); }

  activate(accountId: string | null) {
    const activation = this.activationChain.then(() => this.activateNow(accountId));
    // Serialize rapid Clerk identity changes so an older manifest load can
    // never resume after and populate the newly active account.
    this.activationChain = activation.catch(() => undefined);
    return activation;
  }
  private async activateNow(accountId: string | null) {
    if (accountId === this.accountId) return;
    // Never allow a completed callback from the old account to update the new one.
    await this.pauseActiveDownloads();
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    this.tasks.clear(); this.generations.clear(); this.active = 0; this.entries.clear(); this.accountId = accountId;
    if (!accountId) {
      this.unsubscribeNetwork?.(); this.unsubscribeNetwork = null;
      this.emit(); return;
    }
    this.watchNetwork();
    this.cellularAllowed = (await AsyncStorage.getItem(PREFERENCE_KEY)) === 'true';
    for (const prefix of OBSOLETE_MANIFEST_PREFIXES) {
      const legacyKey = `${prefix}${accountId}`;
      const legacyRaw = await AsyncStorage.getItem(legacyKey);
      if (legacyRaw) {
        try {
          const legacy = JSON.parse(legacyRaw) as ReelDownload[];
          if (Array.isArray(legacy)) {
            await Promise.all(legacy.flatMap((entry) => [
              entry?.uri ? FileSystem.deleteAsync(entry.uri, { idempotent: true }).catch(() => undefined) : Promise.resolve(),
              entry?.objectPath ? FileSystem.deleteAsync(this.partialUriFor(entry), { idempotent: true }).catch(() => undefined) : Promise.resolve(),
            ]));
          }
        } catch {
          // Obsolete manifests are discarded even when malformed.
        }
        await AsyncStorage.removeItem(legacyKey);
      }
    }
    const raw = await AsyncStorage.getItem(this.manifestKey());
    let persisted: ReelDownload[] = [];
    try {
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      persisted = Array.isArray(parsed) ? parsed.filter((entry): entry is ReelDownload =>
        !!entry && typeof entry === 'object' && typeof (entry as ReelDownload).gameId === 'number' &&
        ((entry as ReelDownload).type === 'highlight' || (entry as ReelDownload).type === 'lowlight') &&
        typeof (entry as ReelDownload).objectPath === 'string') : [];
    } catch {
      // Corrupted storage must not prevent authentication/navigation.
      await AsyncStorage.removeItem(this.manifestKey());
    }
    for (const entry of persisted) {
      // Never trust a persisted URI when changing identities. Recompute every
      // path from the currently active account and the reel identity.
      const durableUri = this.uriFor(entry);
      const info = await FileSystem.getInfoAsync(durableUri);
      // A manifest alone is never proof of completion: interrupted .part files and
      // zero-byte responses are discarded and re-queued only with a fresh URL.
      const sizeMatches = entry.expectedBytes == null || (info.exists && info.size === entry.expectedBytes);
      if (info.exists && (info.size ?? 0) > MIN_COMPLETE_BYTES && sizeMatches) {
        // The v2 final path is written only by atomically promoting a verified
        // .part file. It can therefore be newer than the manifest when the OS
        // kills the process between moveAsync and the final AsyncStorage write.
        // Recover it instead of deleting good offline media and downloading it
        // again merely because the persisted status is stale.
        this.entries.set(key(entry.gameId, entry.type, entry.objectPath), {
          ...entry,
          uri: durableUri,
          status: 'downloaded',
          sizeBytes: info.size,
          expectedBytes: entry.expectedBytes ?? info.size,
          bytesWritten: info.size,
          resumeData: undefined,
          needsUrlRefresh: false,
          error: undefined,
        });
      } else {
        const partialUri = this.partialUriFor(entry);
        const partialInfo = await FileSystem.getInfoAsync(partialUri);
        const partialBytes = partialInfo.exists ? partialInfo.size ?? 0 : 0;
        const hasNativeResume = typeof entry.resumeData === 'string' && entry.resumeData.length > 0;
        const hasRangeResume = Platform.OS === 'ios' && partialBytes > 0;
        if (hasNativeResume || hasRangeResume) {
          // iOS streams into the account-scoped .part file so a fresh signed URL
          // can continue with HTTP Range. Other platforms use the native token.
          // Wait for discovery/playback to replace the expired signed URL before
          // resuming after a process relaunch.
          this.entries.set(key(entry.gameId, entry.type, entry.objectPath), {
            ...entry,
            uri: this.uriFor(entry),
            status: 'queued',
            bytesWritten: partialBytes,
            needsUrlRefresh: true,
            error: undefined,
          });
          continue;
        }
        await FileSystem.deleteAsync(info.uri, { idempotent: true }).catch(() => undefined);
        await FileSystem.deleteAsync(partialUri, { idempotent: true }).catch(() => undefined);
        // A queued/downloading record means the app or OS interrupted it. Keep
        // an explicit retryable state rather than silently dropping the reel.
        this.entries.set(key(entry.gameId, entry.type, entry.objectPath), {
          ...entry, uri: this.uriFor(entry), status: 'failed',
          error: entry.status === 'downloading' ? 'Download interrupted. Retry when connected.' : entry.error ?? 'Download needs retry.',
        });
      }
    }
    await this.persist();
    this.emit(); this.pump();
  }
  async setCellularAllowed(value: boolean) {
    this.cellularAllowed = value;
    await AsyncStorage.setItem(PREFERENCE_KEY, String(value));
    this.emit(); this.pump();
  }
  isCellularAllowed() { return this.cellularAllowed; }
  private watchNetwork() {
    if (this.unsubscribeNetwork || Platform.OS === 'web') return;
    this.unsubscribeNetwork = NetInfo.addEventListener((state) => {
      this.networkType = state.type;
      this.connected = state.isConnected === true;
      this.emit(); this.pump();
    });
  }
  // Deliberately public for deterministic unit tests; production updates this
  // only through NetInfo's live subscription.
  setNetworkForTesting(type: NetInfoStateType | 'unknown', connected: boolean) {
    this.networkType = type; this.connected = connected; this.pump();
  }
  private canDownload() {
    if (!this.connected) return false;
    return this.networkType === 'wifi' || this.networkType === 'ethernet' ||
      (this.networkType === 'cellular' && this.cellularAllowed);
  }
  async persist() {
    if (!this.accountId) return;
    const manifestKey = this.manifestKey();
    const snapshot = JSON.stringify(this.snapshot());
    const write = this.persistenceChain
      .catch(() => undefined)
      .then(() => AsyncStorage.setItem(manifestKey, snapshot));
    this.persistenceChain = write;
    await write;
  }
  async pauseActiveDownloads() {
    if (!this.accountId || this.tasks.size === 0) return;
    await Promise.all([...this.tasks.entries()].map(async ([id, task]) => {
      const entry = this.entries.get(id);
      if (!entry || entry.status !== 'downloading') return;
      // Retire the in-flight completion before pausing so its catch handler cannot
      // delete the resumable bytes after this checkpoint has been persisted.
      this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
      const paused = await task.pauseAsync().catch(() => undefined);
      if (this.entries.get(id) !== entry) return;
      if (!paused?.resumeData) {
        entry.status = 'failed';
        entry.error = 'Download could not be saved for resume. Retry when connected.';
        entry.resumeData = undefined;
        this.tasks.delete(id);
        if (Platform.OS !== 'ios') {
          await FileSystem.deleteAsync(this.partialUriFor(entry), { idempotent: true }).catch(() => undefined);
        }
        return;
      }
      const partialInfo = await FileSystem.getInfoAsync(this.partialUriFor(entry));
      entry.resumeData = paused.resumeData;
      entry.bytesWritten = partialInfo.exists ? partialInfo.size : entry.bytesWritten;
      entry.status = 'queued';
      entry.error = undefined;
      this.tasks.delete(id);
    }));
    await this.persist();
    this.emit();
  }
  async enqueue(input: Omit<ReelDownload, 'status' | 'requestedAt'>, priority = false) {
    if (!this.accountId || Platform.OS === 'web') return;
    const id = key(input.gameId, input.type, input.objectPath);
    const current = this.entries.get(id);
    if (current?.status === 'downloaded') return current;
    if (current?.status === 'queued' || current?.status === 'downloading') {
      // Discovery and an opened game can request the same reel concurrently.
      // Keep the existing transfer object; only queued work may adopt a newer
      // signed URL, and either state may be promoted in queue priority.
      if (current.status === 'queued') {
        current.url = input.url;
        current.needsUrlRefresh = false;
      }
      if (priority) current.priority = 1;
      await this.persist(); this.emit();
      if (current.status === 'queued') this.pump(priority ? id : undefined);
      return current;
    }
    const entry: ReelDownload = { ...input, status: 'queued', requestedAt: Date.now(), priority: priority ? 1 : 0, uri: this.uriFor(input) };
    this.entries.set(id, entry);
    await this.persist(); this.emit();
    this.pump(priority ? id : undefined);
    return entry;
  }
  async retry(gameId: number, type: ReelType, objectPath: string) {
    const entry = this.get(gameId, type, objectPath);
    if (!entry || entry.status === 'queued' || entry.status === 'downloading') return entry;
    entry.status = 'queued'; entry.error = undefined; entry.requestedAt = Date.now();
    entry.resumeData = undefined; entry.needsUrlRefresh = false;
    await FileSystem.deleteAsync(entry.uri!, { idempotent: true }).catch(() => undefined);
    await FileSystem.deleteAsync(this.partialUriFor(entry), { idempotent: true }).catch(() => undefined);
    await this.persist(); this.emit(); this.pump(key(gameId, type, objectPath));
  }
  async invalidate(gameId: number, type: ReelType, objectPath?: string | null) {
    if (!objectPath) return;
    const id = key(gameId, type, objectPath); const entry = this.entries.get(id);
    // Retire the generation before awaiting pause/delete. Even if URLSession's
    // completion callback arrives late, it cannot restore invalidated media.
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    this.entries.delete(id);
    const task = this.tasks.get(id);
    if (task) {
      this.tasks.delete(id);
      await task.pauseAsync().catch(() => undefined);
    }
    this.controllers.get(id)?.abort();
    this.controllers.delete(id);
    if (entry?.uri) await FileSystem.deleteAsync(entry.uri, { idempotent: true }).catch(() => undefined);
    await FileSystem.deleteAsync(this.partialUriFor({ gameId, type, objectPath }), { idempotent: true }).catch(() => undefined);
    await this.persist(); this.emit();
  }
  async discover(token: string) {
    if (!this.accountId || Platform.OS === 'web') return;
    const accountAtStart = this.accountId;
    const base = process.env.EXPO_PUBLIC_DOMAIN ? `https://${process.env.EXPO_PUBLIC_DOMAIN}` : '';
    try {
      const gamesResponse = await fetch(`${base}/api/games`, { headers: { Authorization: `Bearer ${token}` } });
      if (!gamesResponse.ok) return;
      const games = await gamesResponse.json() as Array<{ id: number }>;
      // Discovery deliberately runs outside navigation and failures are silent:
      // viewing a game still requests its reel normally.
      await Promise.all(games.slice(0, 30).flatMap((game) => (['highlight', 'lowlight'] as ReelType[]).map(async (type) => {
        const reelResponse = await fetch(`${base}/api/games/${game.id}/${type}`, { headers: { Authorization: `Bearer ${token}` } });
        if (!reelResponse.ok || this.accountId !== accountAtStart) return;
        const reel = await reelResponse.json() as Record<string, unknown>;
        const objectPath = reel[type === 'highlight' ? 'highlightObjectPath' : 'lowlightObjectPath'];
        if (reel.status !== 'ready' || typeof objectPath !== 'string') return;
        const stream = await fetch(`${base}/api/games/${game.id}/stream-token/${type}`, { headers: { Authorization: `Bearer ${token}` } });
        if (!stream.ok || this.accountId !== accountAtStart) return;
        const data = await stream.json() as { streamUrl?: string; token?: string; proxyType?: string };
        // Reel HLS responses retain streamUrl as the token-bound MP4 range
        // endpoint so offline downloads never try to save an M3U8 manifest.
        const url = data.streamUrl ?? `${base}/api/games/${game.id}/stream/${type}?t=${data.token}`;
        await this.enqueue({ gameId: game.id, type, objectPath, url });
      })));
    } catch {
      // Prefetch is opportunistic; do not surface a navigation-blocking error.
    }
  }
  private pump(priorityId?: string) {
    if (!this.canDownload()) return;
    while (this.active < this.concurrency) {
      const next = priorityId ? this.entries.get(priorityId) : [...this.entries.values()].filter((e) => e.status === 'queued' && !e.needsUrlRefresh).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.requestedAt - b.requestedAt)[0];
      priorityId = undefined;
      if (!next || next.status !== 'queued' || next.needsUrlRefresh) return;
      void this.download(next);
    }
  }
  private async download(entry: ReelDownload) {
    if (!this.accountId || entry.status !== 'queued') return;
    const accountAtStart = this.accountId; const id = key(entry.gameId, entry.type, entry.objectPath);
    const generation = (this.generations.get(id) ?? 0) + 1;
    this.generations.set(id, generation);
    let task: ReturnType<typeof FileSystem.createDownloadResumable> | null = null;
    let controller: AbortController | null = null;
    this.active += 1; entry.status = 'downloading'; await this.persist(); this.emit();
    try {
      await FileSystem.makeDirectoryAsync(`${REEL_STORAGE_ROOT}reels/${hash(accountAtStart)}`, { intermediates: true });
      const partialUri = this.partialUriFor(entry);
      const useIosRangeProxy =
        Platform.OS === 'ios' &&
        entry.url.includes('/api/games/') &&
        entry.url.includes('proxy=1');
      if (!entry.resumeData && !useIosRangeProxy) {
        await FileSystem.deleteAsync(partialUri, { idempotent: true }).catch(() => undefined);
      }
      // createDownloadResumable is used rather than File.downloadFileAsync so iOS
      // receives an NSURLSession background transfer. iOS may finish it after the
      // app backgrounds; force-quitting cancels system-managed transfers.
      let result: { uri: string; status: number; headers: Record<string, string> } | undefined;
      if (useIosRangeProxy) {
        controller = new AbortController();
        this.controllers.set(id, controller);
        result = await this.downloadRange(entry, partialUri, id, generation, controller.signal);
      } else {
        task = FileSystem.createDownloadResumable(
          entry.url,
          partialUri,
          { sessionType: FileSystemSessionType.BACKGROUND },
          ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
            if (this.entries.get(id) !== entry || this.generations.get(id) !== generation) return;
            entry.bytesWritten = totalBytesWritten;
            if (totalBytesExpectedToWrite > 0) entry.expectedBytes = totalBytesExpectedToWrite;
            this.emit();
          },
          entry.resumeData,
        );
        this.tasks.set(id, task);
        result = await task.downloadAsync();
      }
      const isCurrent = this.accountId === accountAtStart &&
        this.generations.get(id) === generation &&
        this.entries.get(id) === entry;
      if (!isCurrent) {
        if (result?.uri) await FileSystem.deleteAsync(result.uri, { idempotent: true }).catch(() => undefined);
        return;
      }
      if (!result || result.status < 200 || result.status >= 300) {
        throw new Error(`Download failed with status ${result?.status ?? 'unknown'}`);
      }
      const info = await FileSystem.getInfoAsync(result.uri);
      if (!info?.exists || (info.size ?? 0) <= MIN_COMPLETE_BYTES) throw new Error('Download was incomplete');
      const contentRange = Object.entries(result.headers).find(([name]) => name.toLowerCase() === 'content-range')?.[1];
      const contentLength = Object.entries(result.headers).find(([name]) => name.toLowerCase() === 'content-length')?.[1];
      const expectedMd5 = Object.entries(result.headers).find(([name]) => name.toLowerCase() === 'x-content-md5')?.[1]?.toLowerCase();
      const expectedFromResponse = Number(contentRange?.match(/\/(\d+)$/)?.[1] ?? contentLength ?? 0);
      const expectedBytes = entry.expectedBytes && entry.expectedBytes > 0
        ? entry.expectedBytes
        : expectedFromResponse;
      if (expectedBytes > 0 && info.size !== expectedBytes) {
        throw new Error(`Download was incomplete (${info.size ?? 0} of ${expectedBytes} bytes)`);
      }
      if (expectedMd5) {
        const checksumInfo = await FileSystem.getInfoAsync(result.uri, { md5: true });
        if (!checksumInfo.exists || !checksumInfo.md5 || checksumInfo.md5.toLowerCase() !== expectedMd5) {
          throw new Error('Download checksum mismatch');
        }
      }
      // Promote only a verified complete transfer. The final URI never points
      // at bytes that are still changing underneath AVPlayer.
      await FileSystem.deleteAsync(entry.uri!, { idempotent: true }).catch(() => undefined);
      await FileSystem.moveAsync({ from: result.uri, to: entry.uri! });
      entry.status = 'downloaded';
      entry.sizeBytes = info.size;
      entry.expectedBytes = expectedBytes > 0 ? expectedBytes : info.size;
      entry.expectedMd5 = expectedMd5;
      entry.bytesWritten = info.size;
      entry.resumeData = undefined;
      entry.needsUrlRefresh = false;
    } catch (error: any) {
      if (this.accountId === accountAtStart &&
          this.generations.get(id) === generation &&
          this.entries.get(id) === entry) {
        const partialUri = this.partialUriFor(entry);
        const partialInfo = await FileSystem.getInfoAsync(partialUri);
        const partialBytes = partialInfo.exists ? partialInfo.size ?? 0 : 0;
        const checksumMismatch = error?.message === 'Download checksum mismatch';
        if (checksumMismatch) {
          await FileSystem.deleteAsync(partialUri, { idempotent: true }).catch(() => undefined);
          entry.status = 'queued';
          entry.error = 'Checksum mismatch; requesting a fresh download URL.';
          entry.bytesWritten = 0;
          entry.expectedBytes = undefined;
          entry.expectedMd5 = undefined;
          entry.resumeData = undefined;
          entry.needsUrlRefresh = true;
        } else if (Platform.OS === 'ios' && partialBytes > 0) {
          // Wi-Fi roaming commonly closes the active fetch while iOS is moving
          // between access points or cellular. Keep every verified byte and ask
          // the screen to refresh the signed URL before resuming with Range.
          entry.status = 'queued';
          entry.error = `Native transfer interrupted after ${(partialBytes / 1024 / 1024).toFixed(1)} MB; refreshing its URL.`;
          entry.bytesWritten = partialBytes;
          entry.resumeData = undefined;
          entry.needsUrlRefresh = true;
        } else {
          entry.status = 'failed';
          entry.error = error?.message ?? 'Download failed';
          await FileSystem.deleteAsync(partialUri, { idempotent: true }).catch(() => undefined);
        }
      }
    } finally {
      // activate() resets bookkeeping for the new account. A late callback from
      // the old account must not delete its task or decrement its active count.
      if (this.accountId === accountAtStart) {
        if (task && this.tasks.get(id) === task) this.tasks.delete(id);
        if (controller && this.controllers.get(id) === controller) this.controllers.delete(id);
        this.active = Math.max(0, this.active - 1);
        await this.persist(); this.emit(); this.pump();
      }
    }
  }
  private async downloadRange(
    entry: ReelDownload,
    partialUri: string,
    id: string,
    generation: number,
    signal: AbortSignal,
  ) {
    const existing = await FileSystem.getInfoAsync(partialUri);
    let offset = existing.exists ? existing.size ?? 0 : 0;
    let totalBytes = entry.expectedBytes && entry.expectedBytes > 0 ? entry.expectedBytes : 0;
    let expectedMd5 = entry.expectedMd5;
    if (!existing.exists) new File(partialUri).create();
    const handle = new File(partialUri).open();
    handle.offset = offset;
    let bytesWritten = offset;
    let lastPersisted = offset;
    try {
      while (totalBytes === 0 || offset < totalBytes) {
        if (this.entries.get(id) !== entry || this.generations.get(id) !== generation) return undefined;
        const rangeEnd = totalBytes > 0
          ? Math.min(offset + IOS_RANGE_CHUNK_BYTES - 1, totalBytes - 1)
          : offset + IOS_RANGE_CHUNK_BYTES - 1;
        const response = await expoFetch(entry.url, {
          headers: { Range: `bytes=${offset}-${rangeEnd}` },
          signal,
        });
        const contentRange = response.headers.get('content-range');
        const md5 = response.headers.get('x-content-md5')?.toLowerCase();
        if (md5 && expectedMd5 && md5 !== expectedMd5) throw new Error('Download checksum mismatch');
        if (md5) expectedMd5 = md5;

        if (response.status === 416) {
          const total = Number(contentRange?.match(/^bytes\s+\*\/(\d+)$/i)?.[1] ?? -1);
          if (offset > 0 && total === offset && (!totalBytes || totalBytes === total)) {
            totalBytes = total;
            break;
          }
          throw new Error('Download server rejected the saved byte range');
        }
        if (!response.ok) throw new Error(`Download failed with status ${response.status}`);

        let chunkBytes: number;
        if (response.status === 206) {
          const match = contentRange?.match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
          if (!match) throw new Error('Download server returned an invalid byte range');
          const [, startText, endText, totalText] = match;
          const start = Number(startText);
          const end = Number(endText);
          const total = Number(totalText);
          if (start !== offset || end < start || end > rangeEnd || total <= end ||
              (totalBytes > 0 && totalBytes !== total)) {
            throw new Error('Download server returned an unexpected byte range');
          }
          totalBytes = total;
          chunkBytes = end - start + 1;
        } else if (response.status === 200 && offset === 0) {
          // A few origins ignore Range for a new request. It is safe only when
          // that complete response itself still fits in one bounded chunk.
          const contentLength = Number(response.headers.get('content-length') ?? 0);
          if (!Number.isSafeInteger(contentLength) || contentLength <= 0 ||
              contentLength > IOS_RANGE_CHUNK_BYTES ||
              (totalBytes > 0 && totalBytes !== contentLength)) {
            throw new Error('Download server did not honor the requested byte range');
          }
          totalBytes = contentLength;
          chunkBytes = contentLength;
        } else {
          throw new Error('Download server did not accept the requested byte range');
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error('Download response had no body');
        let chunkWritten = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            if (chunkWritten + value.byteLength > chunkBytes) {
              throw new Error('Download response exceeded its requested byte range');
            }
            handle.writeBytes(value);
            chunkWritten += value.byteLength;
            bytesWritten += value.byteLength;
            if (this.entries.get(id) !== entry || this.generations.get(id) !== generation) {
              await reader.cancel();
              return undefined;
            }
            entry.bytesWritten = bytesWritten;
            entry.expectedBytes = totalBytes;
            entry.expectedMd5 = expectedMd5;
            this.emit();
            if (bytesWritten - lastPersisted >= 1024 * 1024) {
              lastPersisted = bytesWritten;
              await this.persist();
            }
          }
        } finally {
          // A reader which throws has already written only its verified prefix;
          // the next attempt begins at that exact file offset.
          if (chunkWritten !== chunkBytes) await reader.cancel().catch(() => undefined);
        }
        if (chunkWritten !== chunkBytes) throw new Error('Download response ended before its requested byte range');
        offset = bytesWritten;
      }
    } finally {
      handle.close();
    }
    await this.persist();
    if (totalBytes <= 0 || bytesWritten !== totalBytes) throw new Error('Download was incomplete');
    const headers: Record<string, string> = {
      'content-range': `bytes 0-${totalBytes - 1}/${totalBytes}`,
    };
    if (expectedMd5) headers['x-content-md5'] = expectedMd5;
    return { uri: partialUri, status: 206, headers };
  }
}

export const reelDownloadManager = new ReelDownloadManager();
type ContextValue = {
  downloads: ReelDownload[];
  cellularAllowed: boolean;
  downloadManagerReady: boolean;
  setCellularAllowed: (value: boolean) => Promise<void>;
};
const ReelDownloadContext = createContext<ContextValue | null>(null);
export function ReelDownloadProvider({
  accountId,
  children,
}: {
  accountId: string | null;
  getToken?: () => Promise<string | null>;
  children: React.ReactNode;
}) {
  const [downloads, setDownloads] = useState<ReelDownload[]>([]);
  const [cellularAllowed, setCellular] = useState(false);
  const [activatedAccountId, setActivatedAccountId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const syncSnapshot = () => {
      if (cancelled) return;
      setDownloads(reelDownloadManager.snapshot());
      setCellular(reelDownloadManager.isCellularAllowed());
    };
    const unsubscribe = reelDownloadManager.subscribe(syncSnapshot);
    void reelDownloadManager.activate(accountId).then(() => {
      if (cancelled) return;
      setActivatedAccountId(accountId);
      syncSnapshot();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [accountId]);
  const downloadManagerReady = accountId !== null && activatedAccountId === accountId;
  return <ReelDownloadContext.Provider value={useMemo(() => ({
    downloads,
    cellularAllowed,
    downloadManagerReady,
    setCellularAllowed: (v) => reelDownloadManager.setCellularAllowed(v),
  }), [downloads, cellularAllowed, downloadManagerReady])}>{children}</ReelDownloadContext.Provider>;
}
export function useReelDownloads() {
  const value = useContext(ReelDownloadContext);
  if (!value) throw new Error('useReelDownloads must be used inside ReelDownloadProvider');
  return value;
}