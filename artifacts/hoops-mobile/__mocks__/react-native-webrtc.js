/**
 * Jest manual mock for react-native-webrtc.
 *
 * react-native-webrtc is a native module that cannot load in the Node/Jest
 * environment. This mock exports the same surface that scorekeeper.tsx
 * imports so that:
 *
 *   1. Tests that import scorekeeper (or lib/fetchIceServers) don't throw
 *      "native module not found".
 *   2. Tests can inspect calls to RTCPeerConnection, RTCIceCandidate, etc.
 *   3. The mock shape documents the exact API the app depends on — a mismatch
 *      between this surface and the real package signals a breaking change.
 *
 * The mock is intentionally minimal: it covers only the symbols imported in
 * scorekeeper.tsx. Extend it here when new WebRTC APIs are adopted.
 */

// RTCPeerConnection — constructor receives { iceServers }, exposes the
// methods / event callbacks used in scorekeeper.tsx.
class RTCPeerConnection {
  constructor(_config) {}

  addTrack = jest.fn();
  close = jest.fn();
  createOffer = jest.fn().mockResolvedValue({ sdp: 'mock-sdp', type: 'offer' });
  setLocalDescription = jest.fn().mockResolvedValue(undefined);
  setRemoteDescription = jest.fn().mockResolvedValue(undefined);
  addIceCandidate = jest.fn().mockResolvedValue(undefined);

  onicecandidate = null;
  onconnectionstatechange = null;
  connectionState = 'new';
}

// RTCIceCandidate — wraps the raw candidate dict received from the signaling
// channel.
class RTCIceCandidate {
  constructor(init) {
    Object.assign(this, init);
  }
  toJSON() { return { ...this }; }
}

// RTCSessionDescription — used when applying the viewer's SDP answer.
class RTCSessionDescription {
  constructor(init) {
    Object.assign(this, init);
  }
}

// mediaDevices.getUserMedia — the primary entry point for opening the camera
// stream used in the WebRTC broadcast.
const mediaDevices = {
  getUserMedia: jest.fn().mockResolvedValue({
    getTracks: () => [],
    getVideoTracks: () => [],
    getAudioTracks: () => [],
  }),
};

module.exports = {
  RTCPeerConnection,
  RTCIceCandidate,
  RTCSessionDescription,
  mediaDevices,
};
