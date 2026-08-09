/**
 * iceRestartCap.test.ts
 *
 * Verifies the broadcaster-side ICE restart cap introduced in scorekeeper.tsx.
 *
 * `attemptIceRestart` is a closure scoped inside `createPeerForViewer`. It
 * manages three phases:
 *   1. Attempts 1–3: sends an ICE-restart SDP offer to the viewer.
 *   2. Attempt 4 (cap): sends `peer-connection-failed` via the signaling WS
 *      instead of another offer, then tears down the peer and all associated
 *      timers so no interval leak occurs.
 *   3. In-flight guard: a second concurrent call while `iceRestartPending` is
 *      true returns immediately without incrementing the counter.
 *
 * The test replicates the exact closure pattern from scorekeeper.tsx using
 * controlled ref-shaped objects and Jest mocks so the logic can be exercised
 * in isolation, without mounting the full component.
 *
 * Covers:
 *   1. Attempts 1–3 each send an ICE-restart SDP offer (not peer-connection-failed).
 *   2. Attempt 4 sends `peer-connection-failed` — not another offer.
 *   3. After the cap: bitrateInterval is cleared (no interval leak).
 *   4. After the cap: disconnectWatchdog is cleared.
 *   5. After the cap: the viewer is removed from webrtcPeersRef and iceRestartCountRef.
 *   6. After the cap: pc.close() is called.
 *   7. A concurrent call while iceRestartPending is true is a no-op.
 */

// ---------------------------------------------------------------------------
// Factory: replicates the attemptIceRestart closure from scorekeeper.tsx
// ---------------------------------------------------------------------------

interface FakeRefs {
  iceRestartCountRef: { current: Map<string, number> };
  bitrateIntervalRef: { current: Map<string, ReturnType<typeof setInterval>> };
  disconnectWatchdogRef: { current: Map<string, ReturnType<typeof setTimeout>> };
  webrtcPeersRef: { current: Map<string, object> };
}

interface FakePc {
  createOffer: jest.Mock;
  setLocalDescription: jest.Mock;
  close: jest.Mock;
}

function makeAttemptIceRestart(
  viewerId: string,
  code: string,
  refs: FakeRefs,
  broadcastWsSend: jest.Mock,
  pc: FakePc,
): () => Promise<void> {
  // This closure is a direct copy of the `attemptIceRestart` implementation
  // in scorekeeper.tsx createPeerForViewer().  Any change to the production
  // code must be reflected here so the tests stay honest.
  let iceRestartPending = false;

  return async function attemptIceRestart() {
    if (iceRestartPending) return;
    const attempts = (refs.iceRestartCountRef.current.get(viewerId) ?? 0) + 1;
    if (attempts > 3) {
      broadcastWsSend({ type: 'peer-connection-failed', code, targetId: viewerId });
      refs.webrtcPeersRef.current.delete(viewerId);
      const interval = refs.bitrateIntervalRef.current.get(viewerId);
      if (interval) {
        clearInterval(interval);
        refs.bitrateIntervalRef.current.delete(viewerId);
      }
      const watchdog = refs.disconnectWatchdogRef.current.get(viewerId);
      if (watchdog) {
        clearTimeout(watchdog);
        refs.disconnectWatchdogRef.current.delete(viewerId);
      }
      refs.iceRestartCountRef.current.delete(viewerId);
      try { pc.close(); } catch {}
      return;
    }
    refs.iceRestartCountRef.current.set(viewerId, attempts);
    iceRestartPending = true;
    try {
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      broadcastWsSend({ type: 'offer', code, targetId: viewerId, sdp: offer.sdp, renegotiate: true });
    } catch (err) {
      console.warn(`[WebRTC] ICE restart failed for viewer ${viewerId}:`, err);
    } finally {
      iceRestartPending = false;
    }
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeRefs(viewerId: string): FakeRefs {
  return {
    iceRestartCountRef:    { current: new Map() },
    bitrateIntervalRef:    { current: new Map([[viewerId, setInterval(() => {}, 999_999)]]) },
    disconnectWatchdogRef: { current: new Map([[viewerId, setTimeout(() => {}, 999_999)]])  },
    webrtcPeersRef:        { current: new Map([[viewerId, {}]])                             },
  };
}

function makeFakePc(): FakePc {
  return {
    createOffer:         jest.fn().mockResolvedValue({ sdp: 'mock-ice-restart-sdp', type: 'offer' }),
    setLocalDescription: jest.fn().mockResolvedValue(undefined),
    close:               jest.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('attemptIceRestart — cap behaviour', () => {

  beforeEach(() => { jest.clearAllMocks(); });

  test('first three calls each send an ICE-restart offer, not peer-connection-failed', async () => {
    const viewerId = 'viewer-cap-1';
    const code     = 'TESTCODE';
    const refs     = makeFakeRefs(viewerId);
    const pc       = makeFakePc();
    const send     = jest.fn();
    const attempt  = makeAttemptIceRestart(viewerId, code, refs, send, pc);

    await attempt(); // attempt 1
    await attempt(); // attempt 2
    await attempt(); // attempt 3

    // Should have sent 3 offers — no peer-connection-failed yet.
    const offerCalls  = send.mock.calls.filter(([m]: [any]) => m.type === 'offer');
    const failedCalls = send.mock.calls.filter(([m]: [any]) => m.type === 'peer-connection-failed');
    expect(offerCalls).toHaveLength(3);
    expect(failedCalls).toHaveLength(0);

    // Counter should be at 3.
    expect(refs.iceRestartCountRef.current.get(viewerId)).toBe(3);
  });

  test('fourth call (cap) sends peer-connection-failed instead of another offer', async () => {
    const viewerId = 'viewer-cap-2';
    const code     = 'TESTCODE';
    const refs     = makeFakeRefs(viewerId);
    const pc       = makeFakePc();
    const send     = jest.fn();
    const attempt  = makeAttemptIceRestart(viewerId, code, refs, send, pc);

    await attempt(); // 1
    await attempt(); // 2
    await attempt(); // 3
    await attempt(); // 4 → cap

    const failedCalls = send.mock.calls.filter(([m]: [any]) => m.type === 'peer-connection-failed');
    expect(failedCalls).toHaveLength(1);
    expect(failedCalls[0][0]).toEqual({
      type: 'peer-connection-failed',
      code,
      targetId: viewerId,
    });

    // No 4th offer should have been sent.
    const offerCalls = send.mock.calls.filter(([m]: [any]) => m.type === 'offer');
    expect(offerCalls).toHaveLength(3);
  });

  test('after the cap: bitrateInterval is cleared (no interval leak)', async () => {
    const viewerId = 'viewer-cap-3';
    const refs     = makeFakeRefs(viewerId);
    const pc       = makeFakePc();
    const attempt  = makeAttemptIceRestart(viewerId, 'CODE', refs, jest.fn(), pc);

    await attempt(); await attempt(); await attempt(); await attempt();

    // The interval must have been removed from bitrateIntervalRef.
    expect(refs.bitrateIntervalRef.current.has(viewerId)).toBe(false);
  });

  test('after the cap: disconnectWatchdog is cleared', async () => {
    const viewerId = 'viewer-cap-4';
    const refs     = makeFakeRefs(viewerId);
    const pc       = makeFakePc();
    const attempt  = makeAttemptIceRestart(viewerId, 'CODE', refs, jest.fn(), pc);

    await attempt(); await attempt(); await attempt(); await attempt();

    expect(refs.disconnectWatchdogRef.current.has(viewerId)).toBe(false);
  });

  test('after the cap: viewer removed from webrtcPeersRef', async () => {
    const viewerId = 'viewer-cap-5';
    const refs     = makeFakeRefs(viewerId);
    const pc       = makeFakePc();
    const attempt  = makeAttemptIceRestart(viewerId, 'CODE', refs, jest.fn(), pc);

    await attempt(); await attempt(); await attempt(); await attempt();

    expect(refs.webrtcPeersRef.current.has(viewerId)).toBe(false);
  });

  test('after the cap: viewer removed from iceRestartCountRef', async () => {
    const viewerId = 'viewer-cap-6';
    const refs     = makeFakeRefs(viewerId);
    const pc       = makeFakePc();
    const attempt  = makeAttemptIceRestart(viewerId, 'CODE', refs, jest.fn(), pc);

    await attempt(); await attempt(); await attempt(); await attempt();

    expect(refs.iceRestartCountRef.current.has(viewerId)).toBe(false);
  });

  test('after the cap: pc.close() is called exactly once', async () => {
    const viewerId = 'viewer-cap-7';
    const refs     = makeFakeRefs(viewerId);
    const pc       = makeFakePc();
    const attempt  = makeAttemptIceRestart(viewerId, 'CODE', refs, jest.fn(), pc);

    await attempt(); await attempt(); await attempt(); await attempt();

    expect(pc.close).toHaveBeenCalledTimes(1);
  });

});

describe('attemptIceRestart — in-flight guard', () => {

  test('a concurrent call while iceRestartPending is true does not increment the counter', async () => {
    const viewerId = 'viewer-inflight';
    const code     = 'CODE2';
    const refs     = makeFakeRefs(viewerId);
    const send     = jest.fn();

    // Use a PC whose createOffer never resolves synchronously so
    // iceRestartPending stays true while the second call fires.
    let resolveOffer!: (v: any) => void;
    const offerPromise = new Promise<{ sdp: string; type: string }>((res) => { resolveOffer = res; });
    const pc: FakePc = {
      createOffer:         jest.fn().mockReturnValue(offerPromise),
      setLocalDescription: jest.fn().mockResolvedValue(undefined),
      close:               jest.fn(),
    };

    const attempt = makeAttemptIceRestart(viewerId, code, refs, send, pc);

    // Start attempt 1 — it hangs waiting for createOffer.
    const p1 = attempt();

    // Fire attempt 2 while attempt 1 is still pending.
    const p2 = attempt();

    // Resolve the pending offer so attempt 1 can finish.
    resolveOffer({ sdp: 'sdp', type: 'offer' });
    await Promise.all([p1, p2]);

    // Only one ICE-restart offer should have been sent (not two).
    const offerCalls = send.mock.calls.filter(([m]: [any]) => m.type === 'offer');
    expect(offerCalls).toHaveLength(1);

    // Counter must be exactly 1 — the second call was a no-op.
    expect(refs.iceRestartCountRef.current.get(viewerId)).toBe(1);
  });

});

describe('attemptIceRestart — refs not set up yet (no interval or watchdog)', () => {

  test('cap path is safe when bitrateInterval and disconnectWatchdog are absent', async () => {
    const viewerId = 'viewer-bare';
    // No entries in bitrateIntervalRef or disconnectWatchdogRef.
    const refs: FakeRefs = {
      iceRestartCountRef:    { current: new Map() },
      bitrateIntervalRef:    { current: new Map() },
      disconnectWatchdogRef: { current: new Map() },
      webrtcPeersRef:        { current: new Map([[viewerId, {}]]) },
    };
    const pc     = makeFakePc();
    const send   = jest.fn();
    const attempt = makeAttemptIceRestart(viewerId, 'CODE', refs, send, pc);

    // Run straight to the cap without pre-populating timers.
    await attempt(); await attempt(); await attempt(); await attempt();

    // peer-connection-failed must still be sent.
    const failedCalls = send.mock.calls.filter(([m]: [any]) => m.type === 'peer-connection-failed');
    expect(failedCalls).toHaveLength(1);

    // pc.close() must still be called.
    expect(pc.close).toHaveBeenCalledTimes(1);
  });

});
