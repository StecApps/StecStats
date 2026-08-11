/**
 * Offline queue utilities for the scorekeeper screen.
 *
 * Two concerns:
 *  1. **Draft autosave** — snapshot the in-progress game state to AsyncStorage
 *     so a crash or force-quit never loses stats.
 *  2. **Offline game queue** — when the network is gone at "End Game" time,
 *     serialise the completed game here and flush it automatically once the
 *     device comes back online.
 *
 * Connectivity is detected by a lightweight HEAD request to the API's
 * health endpoint — no native NetInfo module required.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { type StatLine, type GameEvent } from './saveGame';

// ── Storage keys ─────────────────────────────────────────────────────────────

export const SCOREKEEPER_DRAFT_KEY = 'stec:scorekeeper-draft';
export const OFFLINE_GAME_QUEUE_KEY = 'stec:offline-game-queue';

// ── Types ─────────────────────────────────────────────────────────────────────

/** In-progress game snapshot autosaved during a scoring session. */
export interface ScorekeeperDraft {
  teamId: number;
  teamName: string;
  opponent: string;
  date: string;
  stats: Record<number, StatLine>;
  events: GameEvent[];
  opponentScore: number;
  teamScoreAdj: number;
  half: 1 | 2;
  seconds: number;
  savedAt: string;
}

/** A completed game that couldn't reach the server — queued for sync. */
export interface QueuedGame {
  /** Client-generated UUID used for server-side idempotency. */
  clientId: string;
  teamId: number;
  opponent: string;
  date: string;
  result: 'W' | 'L';
  teamScore: number;
  opponentScore: number;
  stats: Array<{ playerId: number } & StatLine>;
  events: GameEvent[];
  queuedAt: string;
}

// ── Draft helpers ─────────────────────────────────────────────────────────────

export async function saveDraft(draft: ScorekeeperDraft): Promise<void> {
  try {
    await AsyncStorage.setItem(SCOREKEEPER_DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // Non-fatal — the in-memory state is still intact
  }
}

export async function loadDraft(): Promise<ScorekeeperDraft | null> {
  try {
    const raw = await AsyncStorage.getItem(SCOREKEEPER_DRAFT_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as ScorekeeperDraft;
  } catch {
    return null;
  }
}

export async function clearDraft(): Promise<void> {
  try {
    await AsyncStorage.removeItem(SCOREKEEPER_DRAFT_KEY);
  } catch {
    // Non-fatal
  }
}

// ── Offline game queue helpers ────────────────────────────────────────────────

/**
 * Reads the offline game queue from AsyncStorage.
 *
 * THROWS on any failure:
 *  - AsyncStorage read error (I/O failure, quota exceeded, etc.)
 *  - Malformed / non-array JSON (corrupted storage)
 *
 * Callers that are writing (queueGame, removeQueuedGame) MUST use this so they
 * never silently overwrite a readable queue with fewer entries than it actually
 * contains.  Read-only callers (display, sync) should catch and handle failures
 * gracefully without masking the underlying problem.
 */
export async function loadQueuedGames(): Promise<QueuedGame[]> {
  // Propagate I/O errors — do NOT swallow them.
  const raw = await AsyncStorage.getItem(OFFLINE_GAME_QUEUE_KEY);
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (parseError) {
    throw new Error(
      `Offline queue is corrupted (JSON parse failed): ${(parseError as Error).message}`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      `Offline queue is corrupted: expected an array, got ${typeof parsed}`,
    );
  }

  return parsed as QueuedGame[];
}

/**
 * Persists a completed game to the offline queue.
 *
 * THROWS on any failure (read, parse, or write) — callers must catch and
 * tell the coach their data was NOT saved rather than silently proceeding.
 * A read/parse failure before the write means we refuse to overwrite the
 * existing queue with just the new entry and risk losing older games.
 */
export async function queueGame(game: QueuedGame): Promise<void> {
  // loadQueuedGames throws on I/O or parse errors — do not catch here.
  const existing = await loadQueuedGames();
  const updated = [...existing, game];
  await AsyncStorage.setItem(OFFLINE_GAME_QUEUE_KEY, JSON.stringify(updated));
}

export async function removeQueuedGame(clientId: string): Promise<void> {
  try {
    // loadQueuedGames throws on I/O or parse errors.  A failed remove is
    // non-fatal — the entry will stay in the queue and be re-synced next
    // time (the server deduplicates via clientGameId), so just log and bail.
    const existing = await loadQueuedGames();
    const updated = existing.filter((g) => g.clientId !== clientId);
    await AsyncStorage.setItem(OFFLINE_GAME_QUEUE_KEY, JSON.stringify(updated));
  } catch (err) {
    console.warn('[OfflineQueue] removeQueuedGame failed:', (err as Error).message);
  }
}

// ── Connectivity probe ────────────────────────────────────────────────────────

/**
 * Returns true if the API is reachable.
 * A lightweight GET to /api/healthz — any HTTP response means we're online;
 * a network-level error (TypeError) means we're offline.
 */
export async function checkConnectivity(apiBase: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const url = apiBase ? `${apiBase}/api/healthz` : '/api/healthz';
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    clearTimeout(timer);
    return res.status < 600; // any HTTP response = network is up
  } catch {
    return false;
  }
}

// ── Client ID generator ───────────────────────────────────────────────────────

/** Generate a simple RFC-4122 v4 UUID without external dependencies. */
export function generateClientId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
