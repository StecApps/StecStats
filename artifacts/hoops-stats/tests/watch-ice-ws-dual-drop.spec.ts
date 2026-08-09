/**
 * watch-ice-ws-dual-drop.spec.ts
 *
 * Confirms that a viewer whose ICE connection hangs AND whose WebSocket drops
 * shortly after eventually reaches "waiting-for-broadcaster" — not stuck on a
 * spinner or "Reconnecting…" indefinitely.
 *
 * Background (Task #508 fix)
 * ---------------------------
 * The ICE-hang watchdog in watch.tsx (lines ~796–822) arms the offerWatchdogRef
 * UNCONDITIONALLY — i.e. after the `if (ws.readyState === WebSocket.OPEN) { ... }`
 * block, not inside it.  This matters for the dual-drop scenario:
 *
 *   1. ICE hangs → ICE watchdog fires while WS is still open.
 *   2. Watchdog sends request-offer and arms the offer watchdog.
 *   3. WS closes (broadcaster offline, gym network drops, etc.).
 *   4. ws.onclose sets state = "reconnecting" and schedules a WS retry.
 *   5. Offer watchdog fires (it was armed before the WS died) → transitions
 *      state from "reconnecting" → "waiting-for-broadcaster".
 *
 * Without the fix the offer watchdog would have been inside the OPEN guard and
 * never armed when WS was closed in step 3, leaving the viewer stuck on
 * "Reconnecting…" until the long WS retry fired.
 *
 * Why the WS must close AFTER the ICE watchdog fires
 * ---------------------------------------------------
 * ws.onclose calls pcRef.current?.close() before the ICE watchdog gets a
 * chance to run.  In a real RTCPeerConnection that sets connectionState =
 * "closed", so the ICE watchdog's guard returns early and the offer watchdog
 * is never armed through that path.  The dual-drop scenario therefore requires
 * the WS to drop AFTER the ICE watchdog has already fired — which is exactly
 * what we simulate by having the WS mock close the connection when the
 * watchdog's follow-up request-offer arrives.
 *
 * Scenario
 * ---------
 * 1. Viewer joins — WS open, `joined` (WebRTC), sends request-offer, offer
 *    received; RTCPeerConnection created.
 * 2. FakePeerConnection stays in connectionState="new" forever (ICE hang).
 * 3. ICE hang watchdog fires (__iceWatchdogMs=200):
 *    - pc.connectionState="new" → guard does not return early
 *    - pc.close() called → connectionState="closed" (realistic behavior)
 *    - WS still open → sends a follow-up request-offer
 *    - offer watchdog armed UNCONDITIONALLY (__offerWatchdogMs=400)
 * 4. WS mock receives the watchdog's request-offer → closes the WS.
 * 5. ws.onclose → pcRef.current?.close() (no-op, PC already closed)
 *    → state = "reconnecting" → WS reconnect delayed 5 s.
 * 6. Offer watchdog fires (400 ms after step 3):
 *    - prev = "reconnecting" (covered by the guard) → "waiting-for-broadcaster"
 * 7. "Stream interrupted" text visible; no infinite loop.
 *
 * What is mocked vs what is exercised
 * -------------------------------------
 * Mocked  : HTTP health-gate, live session status, ICE server config,
 *           WS signaling server, RTCPeerConnection (browser layer)
 * Exercised: watch.tsx ICE-hang watchdog unconditional offerWatchdog arming
 *            (lines ~813–821), state transition "reconnecting" →
 *            "waiting-for-broadcaster", absence of infinite retry loop
 */

import { test, expect } from "@playwright/test";

const CODE = "DUAL1";

// Minimal SDP offer accepted by the browser's SDP parser.
const OFFER_SDP = [
  "v=0",
  "o=- 1234567890 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE 0",
  "a=msid-semantic: WMS",
  "m=video 9 UDP/TLS/RTP/SAVPF 96",
  "c=IN IP4 0.0.0.0",
  "a=rtcp:9 IN IP4 0.0.0.0",
  "a=ice-ufrag:dualufrag01",
  "a=ice-pwd:dualpassword01dualpassword01dual",
  "a=ice-options:trickle",
  "a=fingerprint:sha-256 " +
    "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:" +
    "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89",
  "a=setup:actpass",
  "a=mid:0",
  "a=sendonly",
  "a=rtcp-mux",
  "a=rtpmap:96 VP8/90000",
].join("\r\n") + "\r\n";

// FakePeerConnection that simulates an ICE hang with realistic close semantics.
//
// Key properties:
//  • connectionState starts as "new" and stays "new" until close() is called —
//    simulating a browser stuck in ICE "checking" without firing "failed".
//  • close() sets connectionState = "closed", matching real browser behaviour.
//    This means ws.onclose calling pcRef.current?.close() after the ICE watchdog
//    has already closed the PC is a no-op (connectionState stays "closed").
//  • setRemoteDescription / createAnswer / setLocalDescription work so the
//    signaling handshake completes and the ICE watchdog is armed normally.
//  • ontrack is never fired, so the component never enters "live".
const FAKE_PC_SCRIPT = `
(function () {
  class FakePeerConnection {
    constructor() {
      this.connectionState    = "new";
      this.iceConnectionState = "new";
      this.ontrack = null;
      this.onicecandidate = null;
      this.onconnectionstatechange = null;
      this.oniceconnectionstatechange = null;
    }

    async setRemoteDescription(_desc) {
      // Accept the offer but never transition to "connected" — ICE hangs.
    }

    async createAnswer() {
      return {
        type: "answer",
        sdp: [
          "v=0",
          "o=- 0 0 IN IP4 127.0.0.1",
          "s=-",
          "t=0 0",
          "a=group:BUNDLE 0",
          "m=video 9 UDP/TLS/RTP/SAVPF 96",
          "c=IN IP4 0.0.0.0",
          "a=mid:0",
          "a=recvonly",
          "a=rtcp-mux",
          "a=rtpmap:96 VP8/90000",
        ].join("\\r\\n") + "\\r\\n",
      };
    }

    async setLocalDescription(_desc) {}

    addIceCandidate() { return Promise.resolve(); }

    close() {
      // Realistic: closing the PC sets connectionState = "closed".
      this.connectionState    = "closed";
      this.iceConnectionState = "closed";
      if (this.onconnectionstatechange)  this.onconnectionstatechange();
      if (this.oniceconnectionstatechange) this.oniceconnectionstatechange();
    }
  }

  window.RTCPeerConnection = FakePeerConnection;
})();
`;

test.describe("Watch page – dual ICE-hang + WS-drop scenario", () => {
  test(
    "viewer reaches waiting-for-broadcaster after ICE hangs and WS drops during reconnect",
    async ({ page }) => {

      await page.addInitScript({ content: FAKE_PC_SCRIPT });

      // ── HTTP mocks ──────────────────────────────────────────────────────────

      await page.route(
        (url) => url.pathname === "/api",
        (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
      );

      // Active session so the component enters "connecting" on load.
      await page.route(
        (url) => url.pathname === `/api/live/${CODE}/status`,
        (route) =>
          route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              active: true,
              opponent: "Away",
              teamName: "Home",
              viewerCount: 0,
              teamScore: 0,
              opponentScore: 0,
            }),
          })
      );

      await page.route(
        (url) => url.pathname === "/api/live/ice-servers",
        (route) =>
          route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
              turnAvailable: false,
            }),
          })
      );

      // ── WebSocket mock ──────────────────────────────────────────────────────
      //
      // The mock distinguishes two request-offer messages:
      //
      //   1st request-offer (from `joined` handler)
      //     → reply with the SDP offer so the PC and ICE watchdog are set up.
      //       Do NOT close the WS — it must stay open so the ICE watchdog can
      //       arm the offer watchdog unconditionally.
      //
      //   2nd request-offer (from the ICE hang watchdog, ~200 ms later)
      //     → close the WS immediately, simulating the network dying right
      //       after the ICE watchdog sends its follow-up.  The offer watchdog
      //       that was armed unconditionally by the ICE watchdog is now the
      //       only remaining timer that can drive the state to
      //       "waiting-for-broadcaster".
      //
      // This sequencing verifies that the offer watchdog is armed BEFORE the
      // WS drops — the core guarantee of the Task #508 fix.

      const requestOfferMessages: string[] = [];
      const answerMessages: Array<{ type: string }> = [];

      await page.routeWebSocket(
        (url) => url.pathname === "/api/live/ws",
        (ws) => {
          ws.onMessage((raw) => {
            let msg: Record<string, unknown>;
            try {
              msg = JSON.parse(
                typeof raw === "string"
                  ? raw
                  : new TextDecoder().decode(raw as unknown as ArrayBuffer)
              );
            } catch {
              return;
            }

            if (msg.type === "join-viewer") {
              // ACK the join as a WebRTC broadcaster so the component enters
              // the full ICE negotiation path and arms the ICE watchdog.
              ws.send(
                JSON.stringify({
                  type: "joined",
                  viewerId: "dual-viewer-001",
                })
              );

            } else if (msg.type === "request-offer") {
              requestOfferMessages.push(msg.code as string);

              if (requestOfferMessages.length === 1) {
                // First request-offer (from `joined` handler) — reply with the
                // SDP offer so the signaling handshake runs and the ICE watchdog
                // is armed.  Keep WS open.
                ws.send(
                  JSON.stringify({
                    type: "offer",
                    viewerId: "dual-viewer-001",
                    sdp: { type: "offer", sdp: OFFER_SDP },
                  })
                );

              } else if (requestOfferMessages.length === 2) {
                // Second request-offer (from the ICE hang watchdog).
                // This is the "WS drops simultaneously" event: close the
                // signaling channel right as the watchdog fires its follow-up.
                // The offer watchdog was already armed unconditionally by the
                // ICE watchdog before this send, so it must still fire.
                ws.close();
              }

            } else if (msg.type === "answer") {
              answerMessages.push(msg as { type: string });
            }
          });
        }
      );

      // ── Navigate with shortened watchdog timeouts ───────────────────────────
      //
      // __iceWatchdogMs=200        — ICE hang watchdog fires 200 ms after offer
      // __offerWatchdogMs=400      — offer watchdog fires 400 ms after ICE watchdog
      //                             (> 200 ms so it outlives the ICE watchdog
      //                             and fires while WS is already closed)
      // __watchReconnectDelayMs=5000 — push WS reconnect far into the future so
      //                             it doesn't land before the offer watchdog fires
      //
      // Timeline (approximate):
      //   T=0:    page load, getLiveStatus → active, WS opens
      //   T≈10ms: joined → 1st request-offer → offer received → ICE watchdog armed
      //   T≈30ms: answer sent back over WS
      //   T≈210ms: ICE watchdog fires → closes PC → sends 2nd request-offer →
      //             arms offer watchdog (400 ms)
      //   T≈210ms: WS mock closes on 2nd request-offer → ws.onclose →
      //             state = "reconnecting" → WS retry in 5000 ms
      //   T≈610ms: offer watchdog fires → "reconnecting" → "waiting-for-broadcaster"
      await page.goto(
        `/watch/${CODE}?__iceWatchdogMs=200&__offerWatchdogMs=400&__watchReconnectDelayMs=5000`
      );

      // ── 1. Signaling handshake completes (answer sent) ──────────────────────
      // Confirms the PC was created and the ICE watchdog was properly armed
      // before the WS dropped.
      await expect
        .poll(() => answerMessages.length, { timeout: 10_000 })
        .toBeGreaterThanOrEqual(1);

      // ── 2. ICE watchdog's follow-up request-offer is sent ───────────────────
      // After __iceWatchdogMs the watchdog fires and sends a second request-offer.
      // The mock closes the WS on receipt, simulating the "dual drop" moment.
      await expect
        .poll(() => requestOfferMessages.length, { timeout: 5_000 })
        .toBe(2);

      // Both request-offer messages must target the correct session code.
      expect(requestOfferMessages[0]).toBe(CODE);
      expect(requestOfferMessages[1]).toBe(CODE);

      // ── 3. Viewer transitions to waiting-for-broadcaster ────────────────────
      // The offer watchdog (armed unconditionally by the ICE watchdog before the
      // WS dropped) fires and transitions state from "reconnecting" →
      // "waiting-for-broadcaster".
      // "Stream interrupted" is the text rendered when
      // state === "waiting-for-broadcaster" and explicitEndRef.current is false.
      await expect(
        page.getByText(/Stream interrupted/)
      ).toBeVisible({ timeout: 5_000 });

      // Connecting and reconnecting overlays must be gone.
      await expect(page.getByText(/Joining the stream/)).not.toBeVisible();
      await expect(page.getByText(/^Reconnecting…$/)).not.toBeVisible();

      // ── 4. No infinite retry loop ────────────────────────────────────────────
      // Wait 1.5× the offer watchdog interval to confirm the viewer stays on
      // "waiting-for-broadcaster" and does not cycle back to connecting/reconnecting.
      // The WS reconnect delay is 5000 ms so it won't fire during this window.
      await page.waitForTimeout(600);

      await expect(page.getByText(/Stream interrupted/)).toBeVisible();
      await expect(page.getByText(/Joining the stream/)).not.toBeVisible();
      await expect(page.getByText(/^Reconnecting…$/)).not.toBeVisible();
    }
  );
});
