/**
 * offlineQueueSync.test.ts
 *
 * Verifies the end-to-end offline-sync contract by importing and running
 * the REAL production `syncQueuedGames` function from useOfflineQueueSync.ts.
 * Any change to that function's request, queue-removal, auth, or error
 * behavior will break these tests immediately.
 *
 *   1. Sync fires and posts the queued game when called with isSignedIn=true.
 *   2. The POST body includes the `clientId` — required for server-side dedup.
 *   3. On a successful 201, the game is removed from the AsyncStorage queue
 *      (no stale duplicate remains for the next sync cycle).
 *   4. On an idempotent replay (server already has the game, returns 201), the
 *      game is ALSO removed — so the queue doesn't keep re-sending it.
 *   5. On a network failure (fetch throws), the game stays in the queue.
 *   6. Sync is skipped when the user is not signed in or the token is absent.
 *   7. syncedGames is returned so the caller can invalidate per-team caches.
 *
 * The offlineQueue helper tests (queueGame / removeQueuedGame) confirm that
 * AsyncStorage round-trips work correctly and accumulate without overwriting.
 */

jest.mock('react-native', () => ({
  AppState: {
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  },
  Platform: { OS: 'ios', Version: '17.0' },
}));

jest.mock('@clerk/expo', () => ({
  useAuth: jest.fn(() => ({
    getToken: jest.fn().mockResolvedValue('test-jwt-token'),
    isSignedIn: true,
  })),
}));

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: jest.fn(() => ({ invalidateQueries: jest.fn() })),
}));

jest.mock('@workspace/api-client-react', () => ({
  getListAllGamesQueryKey: jest.fn(() => ['listAllGames']),
  getListTeamGamesQueryKey: jest.fn((id: number) => ['listTeamGames', id]),
}));

// ── In-memory AsyncStorage ───────────────────────────────────────────────────
let mockAsyncStore: Record<string, string> = {};
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (k: string) => mockAsyncStore[k] ?? null),
    setItem: jest.fn(async (k: string, v: string) => { mockAsyncStore[k] = v; }),
    removeItem: jest.fn(async (k: string) => { delete mockAsyncStore[k]; }),
  },
}));

// ── fetch ─────────────────────────────────────────────────────────────────────
const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

// ── Production imports (after mocks) ─────────────────────────────────────────
import { syncQueuedGames } from '../lib/useOfflineQueueSync';
import {
  loadQueuedGames,
  queueGame,
  removeQueuedGame,
  type QueuedGame,
} from '../lib/offlineQueue';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeQueuedGame(overrides: Partial<QueuedGame> = {}): QueuedGame {
  return {
    clientId: 'test-client-id-abc123',
    teamId: 1,
    opponent: 'Rivals',
    date: '2026-08-14',
    result: 'W',
    teamScore: 80,
    opponentScore: 70,
    stats: [],
    events: [],
    queuedAt: new Date().toISOString(),
    ...overrides,
  };
}

const DEFAULT_DEPS = {
  apiBase: 'https://api.example.com',
  isSignedIn: true,
  getToken: jest.fn<Promise<string | null>, []>().mockResolvedValue('test-jwt-token'),
};

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockAsyncStore = {};
  mockFetch.mockReset();
  (DEFAULT_DEPS.getToken as jest.Mock).mockResolvedValue('test-jwt-token');
});

// ---------------------------------------------------------------------------
// Tests — offline queue utilities (roundtrip through real AsyncStorage mock)
// ---------------------------------------------------------------------------

describe('offlineQueue utilities', () => {
  it('queueGame adds a game to AsyncStorage and loadQueuedGames returns it', async () => {
    const game = makeQueuedGame();
    await queueGame(game);

    const loaded = await loadQueuedGames();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].clientId).toBe('test-client-id-abc123');
  });

  it('queueGame accumulates multiple games without overwriting earlier ones', async () => {
    await queueGame(makeQueuedGame({ clientId: 'id-1', date: '2026-08-01' }));
    await queueGame(makeQueuedGame({ clientId: 'id-2', date: '2026-08-02' }));

    const loaded = await loadQueuedGames();
    expect(loaded).toHaveLength(2);
    expect(loaded.map((g) => g.clientId)).toEqual(['id-1', 'id-2']);
  });

  it('removeQueuedGame removes only the matching clientId', async () => {
    await queueGame(makeQueuedGame({ clientId: 'keep-me' }));
    await queueGame(makeQueuedGame({ clientId: 'remove-me' }));

    await removeQueuedGame('remove-me');

    const loaded = await loadQueuedGames();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].clientId).toBe('keep-me');
  });

  it('loadQueuedGames returns an empty array when the queue is empty', async () => {
    const loaded = await loadQueuedGames();
    expect(loaded).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests — syncQueuedGames (real production function)
// ---------------------------------------------------------------------------

describe('syncQueuedGames — happy path (single game)', () => {
  it('POSTs the queued game to /api/games when called', async () => {
    const game = makeQueuedGame();
    await queueGame(game);

    mockFetch.mockResolvedValue({ ok: true, status: 201 });

    await syncQueuedGames(DEFAULT_DEPS);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/games');
    expect(init.method).toBe('POST');
  });

  it('includes the clientId in the POST body for server-side dedup', async () => {
    const game = makeQueuedGame({ clientId: 'dedup-key-123' });
    await queueGame(game);

    mockFetch.mockResolvedValue({ ok: true, status: 201 });

    await syncQueuedGames(DEFAULT_DEPS);

    const [, init] = mockFetch.mock.calls[0];
    const sent = JSON.parse(init.body as string);
    expect(sent.clientId).toBe('dedup-key-123');
  });

  it('includes the Authorization header with the bearer token', async () => {
    await queueGame(makeQueuedGame());

    mockFetch.mockResolvedValue({ ok: true, status: 201 });

    await syncQueuedGames(DEFAULT_DEPS);

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers['Authorization']).toBe('Bearer test-jwt-token');
  });

  it('removes the game from the queue after a successful 201', async () => {
    const game = makeQueuedGame({ clientId: 'remove-after-sync' });
    await queueGame(game);

    mockFetch.mockResolvedValue({ ok: true, status: 201 });

    await syncQueuedGames(DEFAULT_DEPS);

    const remaining = await loadQueuedGames();
    expect(remaining).toHaveLength(0);
  });

  it('returns synced=1 and the synced game on success (for per-team cache invalidation)', async () => {
    const game = makeQueuedGame({ clientId: 'idempotent-replay-key', teamId: 7 });
    await queueGame(game);

    mockFetch.mockResolvedValue({ ok: true, status: 201 });

    const { synced, syncedGames } = await syncQueuedGames(DEFAULT_DEPS);

    expect(synced).toBe(1);
    expect(syncedGames).toHaveLength(1);
    expect(syncedGames[0].clientId).toBe('idempotent-replay-key');
    expect(syncedGames[0].teamId).toBe(7);
    // Queue must be empty — no re-send on next cycle
    const remaining = await loadQueuedGames();
    expect(remaining).toHaveLength(0);
  });
});

describe('syncQueuedGames — multiple queued games', () => {
  it('syncs all queued games and empties the queue', async () => {
    await queueGame(makeQueuedGame({ clientId: 'game-1' }));
    await queueGame(makeQueuedGame({ clientId: 'game-2' }));

    mockFetch.mockResolvedValue({ ok: true, status: 201 });

    const { synced, syncedGames } = await syncQueuedGames(DEFAULT_DEPS);

    expect(synced).toBe(2);
    expect(syncedGames).toHaveLength(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const remaining = await loadQueuedGames();
    expect(remaining).toHaveLength(0);
  });

  it('sends each game with its own clientId', async () => {
    await queueGame(makeQueuedGame({ clientId: 'game-alpha' }));
    await queueGame(makeQueuedGame({ clientId: 'game-beta' }));

    mockFetch.mockResolvedValue({ ok: true, status: 201 });

    await syncQueuedGames(DEFAULT_DEPS);

    const sentIds = mockFetch.mock.calls.map(([, init]) =>
      JSON.parse(init.body as string).clientId,
    );
    expect(sentIds).toEqual(expect.arrayContaining(['game-alpha', 'game-beta']));
  });
});

describe('syncQueuedGames — retry and error paths', () => {
  it('keeps the game in the queue when the network throws (no ACK received)', async () => {
    const game = makeQueuedGame({ clientId: 'keep-on-network-error' });
    await queueGame(game);

    mockFetch.mockRejectedValue(new TypeError('Network request failed'));

    await syncQueuedGames(DEFAULT_DEPS);

    const remaining = await loadQueuedGames();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].clientId).toBe('keep-on-network-error');
  });

  it('discards the game on a 4xx (e.g. team deleted) rather than blocking future syncs', async () => {
    const game = makeQueuedGame({ clientId: 'discard-on-404' });
    await queueGame(game);

    mockFetch.mockResolvedValue({ ok: false, status: 404 });

    await syncQueuedGames(DEFAULT_DEPS);

    const remaining = await loadQueuedGames();
    expect(remaining).toHaveLength(0);
  });

  it('leaves the game in the queue on a 5xx (server error — retry later)', async () => {
    const game = makeQueuedGame({ clientId: 'retry-on-5xx' });
    await queueGame(game);

    mockFetch.mockResolvedValue({ ok: false, status: 503 });

    await syncQueuedGames(DEFAULT_DEPS);

    const remaining = await loadQueuedGames();
    expect(remaining).toHaveLength(1);
  });

  it('returns synced=0 and empty syncedGames when the queue is empty', async () => {
    const { synced, syncedGames } = await syncQueuedGames(DEFAULT_DEPS);

    expect(synced).toBe(0);
    expect(syncedGames).toHaveLength(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not sync when the user is not signed in', async () => {
    await queueGame(makeQueuedGame());

    const { synced } = await syncQueuedGames({ ...DEFAULT_DEPS, isSignedIn: false });

    expect(synced).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
    const remaining = await loadQueuedGames();
    expect(remaining).toHaveLength(1);
  });

  it('does not sync when getToken returns null (token not yet available)', async () => {
    await queueGame(makeQueuedGame());

    const { synced } = await syncQueuedGames({
      ...DEFAULT_DEPS,
      getToken: jest.fn().mockResolvedValue(null),
    });

    expect(synced).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns empty syncedGames when nothing was synced', async () => {
    // Empty queue → nothing synced → no teamIds to invalidate
    const { synced, syncedGames } = await syncQueuedGames(DEFAULT_DEPS);
    expect(synced).toBe(0);
    expect(syncedGames).toHaveLength(0);
  });
});
