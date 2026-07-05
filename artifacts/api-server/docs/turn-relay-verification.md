# TURN Relay Verification Report

**Task**: Verify streams actually work on real restrictive networks, not just in this dev sandbox.
**Date**: 2026-07-05

## Scope and constraint

The task's acceptance criteria call for two real devices/browsers, one forced
onto a network that blocks direct/STUN UDP traffic (VPN/firewall/throttling
tool), confirming the stream connects and `RTCPeerConnection.getStats()`
shows a `relay` candidate type on the working connection.

This verification was performed by an autonomous agent with no access to
physical devices, no camera hardware in its sandbox, and no ability to
configure a real restrictive network (corporate firewall, hotel/school wifi,
VPN). A literal two-device field test is out of reach for that reason and is
tracked as an explicit follow-up (see "Outstanding" below) for a human with
real hardware to complete.

## What was actually verified

Instead, the agent used the standard technique for proving a TURN relay path
is load-bearing: forcing `RTCPeerConnection`'s `iceTransportPolicy` to
`"relay"` removes all host/server-reflexive (STUN) candidates from ICE
gathering, so a connection can only succeed by actually routing media through
the TURN server (Metered.ca). This directly exercises the same fallback path
a real restrictive network would force, without needing to reproduce the
network condition itself.

Setup:
- Temporarily patched `record.tsx` / `watch.tsx` to accept two test-only
  query params: `e2eForceRelay=1` (sets `iceTransportPolicy: "relay"` on that
  page's `RTCPeerConnection`) and `e2eFakeMedia=1` (replaces
  `getUserMedia` with a synthetic canvas+oscillator stream, since the test
  sandbox has no camera).
- Added a temporary console log on `oniceconnectionstatechange` reporting the
  selected candidate pair's local/remote `candidateType` from `getStats()`.
- Ran two independent Playwright browser contexts via the project's
  `runTest` E2E harness: one broadcasting via `/record`, one viewing via
  `/watch/:code`.
- Confirmed `GET /api/live/ice-servers` returns real Metered.ca STUN+TURN
  URLs/credentials (not the STUN-only fallback) before testing.
- Reverted all temporary instrumentation afterward (verified via `grep` and a
  clean `tsc --noEmit`); no test-only code remains in the app.

## Results

**Test 1 — relay forced on broadcaster only** (simulates the coach being on
a restrictive network, viewer on a normal network):
- Stream connected; the viewer's video played live.
- Broadcaster side: `{ localType: "relay", remoteType: "srflx" }` — the
  broadcaster had no candidates available except TURN relay and still
  connected successfully.
- Viewer side (consistent with the above): `{ localType: "srflx", remoteType: "relay" }`.

**Test 2 — relay forced on both broadcaster and viewer** (simulates both
sides being restrictive, the strictest case):
- Stream connected; the viewer's video played live.
- Broadcaster side: `{ localType: "relay", remoteType: "relay" }`.
- Viewer side: `{ localType: "relay", remoteType: "relay" }`.

Both runs succeeded end-to-end with real (synthetic) audio/video flowing
entirely through the Metered.ca TURN relay, matching the task's stated
"Done looks like" criterion (connection succeeds, `getStats()` reports
`relay` candidate type) via a network-restriction proxy rather than physical
hardware.

## Outstanding

A genuine field test with two physical devices on a real restrictive network
(not artificially forced via code) has not been performed, since it requires
hardware and network access outside an autonomous sandbox. This is tracked
as a separate follow-up task: "Confirm a stream still works when a coach is
on a real restrictive network (hotel/school wifi, mobile hotspot)".

## Relevant files

- `artifacts/api-server/src/lib/liveStream.ts` (`getIceServers`)
- `artifacts/api-server/src/routes/live.ts` (`GET /live/ice-servers`)
- `artifacts/hoops-stats/src/lib/liveStream.ts` (`getIceServers` client helper)
- `artifacts/hoops-stats/src/pages/record.tsx`, `artifacts/hoops-stats/src/pages/watch.tsx`
