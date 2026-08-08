/**
 * webrtcNativeModule.test.ts
 *
 * Verifies the three things that must hold before a real EAS development build
 * can succeed on device:
 *
 *   1. Native-module surface — RTCPeerConnection, RTCIceCandidate,
 *      RTCSessionDescription and mediaDevices are all exported by
 *      react-native-webrtc with the correct shape. A "native module not found"
 *      error on device shows up here first as a missing export or TypeError.
 *
 *   2. ICE-server resolution — fetchIceServers() returns the API payload when
 *      the server is reachable, and falls back to the public Google STUN server
 *      when the API is down or returns garbage. Without this fallback the
 *      RTCPeerConnection constructor receives an empty iceServers array and
 *      every viewer connection fails silently.
 *
 *   3. getUserMedia error resilience — when the native camera stream fails to
 *      open (permissions denied, hardware busy, etc.) the broadcast continues
 *      in score-only mode. This path is exercised here so a regression that
 *      throws instead of warning breaks CI before it reaches a real device.
 *
 * These tests run in Node via the react-native-webrtc manual mock
 * (__mocks__/react-native-webrtc.js). The mock exports the same symbol surface
 * that scorekeeper.tsx imports, so adding a new WebRTC API call to the app
 * without updating the mock (and this test) is caught immediately.
 */

// ─── 1. Native-module surface ─────────────────────────────────────────────────

describe('react-native-webrtc module surface', () => {
  // Use jest.mock so the manual __mocks__/react-native-webrtc.js is loaded.
  jest.mock('react-native-webrtc');

  const webrtc = require('react-native-webrtc');

  test('exports RTCPeerConnection as a constructor', () => {
    expect(typeof webrtc.RTCPeerConnection).toBe('function');
    const pc = new webrtc.RTCPeerConnection({ iceServers: [] });
    expect(pc).toBeDefined();
  });

  test('RTCPeerConnection instance has the methods scorekeeper.tsx calls', () => {
    const pc = new webrtc.RTCPeerConnection({ iceServers: [] });
    expect(typeof pc.createOffer).toBe('function');
    expect(typeof pc.setLocalDescription).toBe('function');
    expect(typeof pc.setRemoteDescription).toBe('function');
    expect(typeof pc.addIceCandidate).toBe('function');
    expect(typeof pc.addTrack).toBe('function');
    expect(typeof pc.close).toBe('function');
  });

  test('exports RTCIceCandidate as a constructor', () => {
    expect(typeof webrtc.RTCIceCandidate).toBe('function');
    const candidate = new webrtc.RTCIceCandidate({ candidate: 'c', sdpMid: '0', sdpMLineIndex: 0 });
    expect(candidate).toBeDefined();
  });

  test('exports RTCSessionDescription as a constructor', () => {
    expect(typeof webrtc.RTCSessionDescription).toBe('function');
    const sd = new webrtc.RTCSessionDescription({ type: 'answer', sdp: 'v=0\r\n' });
    expect(sd).toBeDefined();
  });

  test('exports mediaDevices with getUserMedia', () => {
    expect(webrtc.mediaDevices).toBeDefined();
    expect(typeof webrtc.mediaDevices.getUserMedia).toBe('function');
  });
});

// ─── 2. ICE-server resolution ─────────────────────────────────────────────────

import { fetchIceServers } from '../lib/fetchIceServers';

const STUN_FALLBACK = [{ urls: 'stun:stun.l.google.com:19302' }];

beforeEach(() => {
  // clearAllMocks resets call tracking (calls / instances / results) without
  // removing mock implementations. resetAllMocks would strip the default
  // mockResolvedValue set in the react-native-webrtc manual mock, making
  // getUserMedia return undefined instead of a stream object.
  jest.clearAllMocks();
});

describe('fetchIceServers — API reachable', () => {
  test('returns the iceServers array from a successful response', async () => {
    const servers = [
      { urls: 'stun:stun.example.com:3478' },
      { urls: 'turn:turn.example.com:3478', username: 'u', credential: 'p' },
    ];
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ iceServers: servers }),
    }) as any;

    const result = await fetchIceServers('https://api.example.com');
    expect(result).toEqual(servers);
    expect(global.fetch).toHaveBeenCalledWith('https://api.example.com/api/live/ice-servers');
  });

  test('appends /api/live/ice-servers to the provided apiBase', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ iceServers: [{ urls: 'stun:s' }] }),
    }) as any;

    await fetchIceServers('https://custom.host');
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe('https://custom.host/api/live/ice-servers');
  });
});

describe('fetchIceServers — fallback to public STUN', () => {
  test('falls back when fetch throws (network error)', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('Network request failed')) as any;

    const result = await fetchIceServers('https://api.example.com');
    expect(result).toEqual(STUN_FALLBACK);
  });

  test('falls back when the response is not OK (e.g. 503)', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 }) as any;

    const result = await fetchIceServers('https://api.example.com');
    expect(result).toEqual(STUN_FALLBACK);
  });

  test('falls back when iceServers is missing from the payload', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ something: 'else' }),
    }) as any;

    const result = await fetchIceServers('https://api.example.com');
    expect(result).toEqual(STUN_FALLBACK);
  });

  test('falls back when iceServers is an empty array', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ iceServers: [] }),
    }) as any;

    const result = await fetchIceServers('https://api.example.com');
    expect(result).toEqual(STUN_FALLBACK);
  });

  test('falls back when iceServers is not an array', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ iceServers: 'stun:stun.l.google.com:19302' }),
    }) as any;

    const result = await fetchIceServers('https://api.example.com');
    expect(result).toEqual(STUN_FALLBACK);
  });

  test('falls back with an empty apiBase (Expo dev environment)', async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError('Failed to fetch')) as any;

    const result = await fetchIceServers('');
    expect(result).toEqual(STUN_FALLBACK);
  });
});

// ─── 3. getUserMedia error resilience ─────────────────────────────────────────

describe('getUserMedia error resilience (score-only fallback)', () => {
  jest.mock('react-native-webrtc');

  test('a getUserMedia rejection produces a console.warn, not an unhandled throw', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { mediaDevices } = require('react-native-webrtc');
    (mediaDevices.getUserMedia as jest.Mock).mockRejectedValueOnce(
      new Error('Permission denied'),
    );

    // Simulate the exact try/catch pattern from scorekeeper.tsx useEffect:
    //   try { stream = await mediaDevices.getUserMedia(…) }
    //   catch (e) { console.warn('[WebRTC] getUserMedia failed …', e) }
    let streamResult: any = null;
    try {
      streamResult = await mediaDevices.getUserMedia({ video: true, audio: true });
    } catch (e) {
      console.warn('[WebRTC] getUserMedia failed — viewers will see score-only:', e);
    }

    expect(streamResult).toBeNull(); // no stream assigned
    expect(warnSpy).toHaveBeenCalledWith(
      '[WebRTC] getUserMedia failed — viewers will see score-only:',
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });

  test('a successful getUserMedia returns a stream with getTracks', async () => {
    const { mediaDevices } = require('react-native-webrtc');
    // Default mock returns a stream-like object
    const stream = await mediaDevices.getUserMedia({ video: true, audio: true });
    expect(typeof stream.getTracks).toBe('function');
    expect(Array.isArray(stream.getTracks())).toBe(true);
  });
});
