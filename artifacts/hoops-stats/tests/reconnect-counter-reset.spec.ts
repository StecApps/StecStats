/**
 * reconnect-counter-reset.spec.ts
 *
 * Verifies that the WS-level reconnect progress counters ("Attempt N of 6 · Xs")
 * reset to zero — and disappear from the UI — once a reconnect succeeds and the
 * stream returns to live state.
 *
 * Two surfaces are tested:
 *
 * A) watch.tsx  — viewer-side counter (`reconnectAttemptCount` / `reconnectElapsedSec`)
 *    The test simulates a real WS disconnect followed by a reconnect and fresh
 *    offer from the broadcaster, using a FakePeerConnection so that ICE resolves
 *    deterministically without a real network.
 *
 * B) record.tsx — broadcaster-side counter (`liveReconnectAttempt` / `liveReconnectElapsedSec`)
 *    Because testing a full broadcaster reconnect requires camera access and auth,
 *    this path is covered via dev-only window hooks exposed by record.tsx in DEV
 *    mode: `__hoopsSimulateLiveReconnect(attempt)` and
 *    `__hoopsSimulateLiveReconnectSuccess()`.
 *
 * What is mocked vs exercised
 * ---------------------------
 * Mocked  : HTTP health-gate, live session status, ICE servers, WS signaling
 *           server, RTCPeerConnection (browser layer only), Clerk auth (test B)
 * Exercised: watch.tsx / record.tsx state machines, counter state/effects,
 *            UI rendering of attempt counter and elapsed seconds
 */

import { test, expect } from "@playwright/test";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const CODE = "RCRT1";

const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY ?? "";

// Minimal SDP that the browser's SDP parser will accept.
const OFFER_SDP = [
  "v=0",
  "o=- 9876543210 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE 0",
  "a=msid-semantic: WMS",
  "m=video 9 UDP/TLS/RTP/SAVPF 96",
  "c=IN IP4 0.0.0.0",
  "a=rtcp:9 IN IP4 0.0.0.0",
  "a=ice-ufrag:rcrtufrag01",
  "a=ice-pwd:rcrtpassword01rcrtpassword01rcrt",
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

// FakePeerConnection: after setRemoteDescription it immediately fires ontrack
// then connectionState="connected", simulating a successful ICE negotiation.
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
      this._closed = false;
    }
    async setRemoteDescription(_desc) {
      if (this._closed) return;
      const self = this;
      setTimeout(function () {
        if (self._closed) return;
        if (self.ontrack) {
          const stream = new MediaStream();
          self.ontrack({ track: { kind: "video" }, streams: [stream] });
        }
        self.connectionState    = "connected";
        self.iceConnectionState = "connected";
        if (self.onconnectionstatechange)  self.onconnectionstatechange();
        if (self.oniceconnectionstatechange) self.oniceconnectionstatechange();
      }, 300);
    }
    async createAnswer() {
      return {
        type: "answer",
        sdp: [
          "v=0", "o=- 0 0 IN IP4 127.0.0.1", "s=-", "t=0 0",
          "a=group:BUNDLE 0",
          "m=video 9 UDP/TLS/RTP/SAVPF 96", "c=IN IP4 0.0.0.0",
          "a=mid:0", "a=recvonly", "a=rtcp-mux", "a=rtpmap:96 VP8/90000",
        ].join("\\r\\n") + "\\r\\n",
      };
    }
    async setLocalDescription(_desc) {}
    addIceCandidate() { return Promise.resolve(); }
    close() { this._closed = true; this.connectionState = "closed"; }
  }
  window.RTCPeerConnection = FakePeerConnection;
})();
`;

// ---------------------------------------------------------------------------
// Helpers for Clerk user lifecycle (used only in test B)
// ---------------------------------------------------------------------------

interface ClerkUser { id: string }

async function createClerkUser(email: string, password: string): Promise<ClerkUser> {
  const res = await fetch("https://api.clerk.com/v1/users", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CLERK_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email_address: [email],
      password,
      skip_password_checks: true,
      skip_password_requirement: true,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to create Clerk user: ${res.status} ${body}`);
  }
  return res.json() as Promise<ClerkUser>;
}

async function deleteClerkUser(id: string) {
  await fetch(`https://api.clerk.com/v1/users/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${CLERK_SECRET_KEY}` },
  });
}

function uniqueEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test-rcrt.example.com`;
}

// ---------------------------------------------------------------------------
// Test A — watch.tsx viewer reconnect counter
// ---------------------------------------------------------------------------

test.describe("Watch page – reconnect counter resets when stream comes back live", () => {
  test(
    "counter shows 'Attempt 1 of 6' during reconnect then vanishes once live",
    async ({ page }) => {
      await page.addInitScript({ content: FAKE_PC_SCRIPT });

      // HTTP mocks
      await page.route(
        (url) => url.pathname === "/api",
        (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
      );
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

      // WS mock — two-phase:
      //   Phase 1: join-viewer → close the socket to trigger onclose / "reconnecting"
      //   Phase 2: on the second connection (isReconnect), send an offer so ICE can succeed
      let connectionCount = 0;
      let serverSideWs: import("@playwright/test").WebSocketRoute | null = null;

      await page.routeWebSocket(
        (url) => url.pathname === "/api/live/ws",
        (ws) => {
          connectionCount += 1;
          serverSideWs = ws;
          const thisConn = connectionCount;

          ws.onMessage((raw) => {
            let msg: Record<string, unknown>;
            try {
              msg = JSON.parse(
                typeof raw === "string" ? raw : new TextDecoder().decode(raw as unknown as ArrayBuffer)
              );
            } catch {
              return;
            }

            if (msg.type === "join-viewer") {
              if (thisConn === 1) {
                // First connection: ack join, then immediately close the WS to
                // simulate a signaling-server drop. The component should enter
                // "reconnecting" state and show the attempt counter.
                ws.send(JSON.stringify({ type: "joined", viewerId: "test-viewer-001" }));
                // Close from server side after a short delay so the message lands first.
                setTimeout(() => ws.close(), 50);
              } else {
                // Second connection (isReconnect=true): ack join, then send an
                // offer so FakePeerConnection can complete the handshake.
                ws.send(JSON.stringify({ type: "joined", viewerId: "test-viewer-001" }));
                setTimeout(() => {
                  ws.send(
                    JSON.stringify({
                      type: "offer",
                      viewerId: "test-viewer-001",
                      sdp: { type: "offer", sdp: OFFER_SDP },
                    })
                  );
                }, 100);
              }
            }
          });
        }
      );

      await page.goto(`/watch/${CODE}`);

      // ── 1. Component enters "connecting" initially ─────────────────────────
      await expect(page.getByText(/Joining the stream/)).toBeVisible({ timeout: 10_000 });

      // ── 2. After WS drop, state becomes "reconnecting" with attempt counter ─
      // Both texts live in the same conditional block — assert them together
      // so they're both checked while the component is still in "reconnecting"
      // state (it transitions back to "connecting" ~1 s later when the retry
      // fires, so checking them sequentially created a race condition).
      await Promise.all([
        expect(page.getByText(/Attempt 1 of 6/)).toBeVisible({ timeout: 10_000 }),
        expect(page.getByText(/Reconnecting…/)).toBeVisible({ timeout: 10_000 }),
      ]);

      // ── 3. After reconnect + ICE success, state is "live" ──────────────────
      await expect(
        page.getByText(/Tap for sound/)
      ).toBeVisible({ timeout: 15_000 });

      // ── 4. The reconnect counter must be gone ──────────────────────────────
      await expect(page.getByText(/Attempt \d+ of \d+/)).not.toBeVisible();
      await expect(page.getByText(/Reconnecting…/)).not.toBeVisible();

      void serverSideWs; // suppress unused-var lint
    }
  );
});

// ---------------------------------------------------------------------------
// Test A2 — watch.tsx reconnect exhaustion → "Connection dropped" state
// ---------------------------------------------------------------------------

test.describe("Watch page – reconnect exhaustion shows 'Connection dropped'", () => {
  test(
    "shows 'Connection dropped' and 'Refresh and try again' after all 6 attempts fail",
    async ({ page }) => {
      await page.addInitScript({ content: FAKE_PC_SCRIPT });

      // HTTP mocks
      await page.route(
        (url) => url.pathname === "/api",
        (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
      );
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

      // WS mock — close every connection immediately after the join-viewer ack
      // so reconnectAttemptsRef increments on each onclose and exhausts all 6.
      await page.routeWebSocket(
        (url) => url.pathname === "/api/live/ws",
        (ws) => {
          ws.onMessage((raw) => {
            let msg: Record<string, unknown>;
            try {
              msg = JSON.parse(
                typeof raw === "string" ? raw : new TextDecoder().decode(raw as unknown as ArrayBuffer)
              );
            } catch {
              return;
            }
            if (msg.type === "join-viewer") {
              ws.send(JSON.stringify({ type: "joined", viewerId: "test-viewer-exhaust" }));
              // Close immediately — simulates a signaling server that keeps dropping.
              setTimeout(() => ws.close(), 30);
            }
          });
        }
      );

      // Use a tiny reconnect delay so the test completes in < 5 s instead of 31 s.
      await page.goto(`/watch/${CODE}?__watchReconnectDelayMs=100`);

      // ── 1. Initial connecting state ────────────────────────────────────────
      await expect(page.getByText(/Joining the stream/)).toBeVisible({ timeout: 10_000 });

      // ── 2. After all 6 WS drops, state must become "ended" ────────────────
      // Total time: ≈ 6 × (30 ms close + 100 ms delay) ≈ 0.8 s; allow 30 s.
      await expect(
        page.getByText("Connection dropped and couldn't be restored.")
      ).toBeVisible({ timeout: 30_000 });

      // ── 3. "Refresh and try again" button must be present ─────────────────
      await expect(
        page.getByRole("button", { name: "Refresh and try again" })
      ).toBeVisible();

      // ── 4. The spinner, "Reconnecting…" heading, and attempt counter must be gone
      await expect(page.getByText(/Reconnecting…/)).not.toBeVisible();
      await expect(page.getByText(/Attempt \d+ of \d+/)).not.toBeVisible();
    }
  );
});

// ---------------------------------------------------------------------------
// Test B — record.tsx broadcaster reconnect counter
// ---------------------------------------------------------------------------

test.describe("Record page – broadcaster reconnect counter resets when stream comes back live", () => {
  let userId: string;
  const email = uniqueEmail("rcrt-rec");
  const password = "RcrtRecordTest!9x";

  test.beforeAll(async () => {
    const user = await createClerkUser(email, password);
    userId = user.id;
  });

  test.afterAll(async () => {
    if (userId) await deleteClerkUser(userId);
  });

  test(
    "shows attempt counter during reconnect then clears it once live state resumes",
    async ({ page }) => {
      await setupClerkTestingToken({ page, userId });

      // Stub data endpoints so the page renders without hitting the DB.
      await page.route("**/api/billing/status", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ plan: "pro", active: true }),
        })
      );
      await page.route("**/api/players", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: "[]" })
      );
      await page.route("**/api/teams", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: "[]" })
      );
      await page.route("**/api/live/ice-servers", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
            turnAvailable: true,
          }),
        })
      );

      await page.goto("/record");

      // Wait for the live stream section to be present (dev hooks mounted here).
      await expect(page.getByText("Live stream link")).toBeVisible({ timeout: 15_000 });

      // ── 1. Inject a mid-reconnect state (attempt 3) via the dev hook ───────
      await page.evaluate(() => (window as any).__hoopsSimulateLiveReconnect(3));

      // The reconnecting banner with attempt counter must appear.
      await expect(
        page.getByText(/Reconnecting live stream/)
      ).toBeVisible({ timeout: 5_000 });
      await expect(
        page.getByText(/attempt 3 of/)
      ).toBeVisible({ timeout: 5_000 });

      // ── 2. Simulate a successful reconnect ─────────────────────────────────
      await page.evaluate(() => (window as any).__hoopsSimulateLiveReconnectSuccess());

      // ── 3. The reconnecting banner and counter must be gone ─────────────────
      await expect(
        page.getByText(/Reconnecting live stream/)
      ).not.toBeVisible({ timeout: 5_000 });
      // No attempt counter text should remain in the DOM.
      await expect(
        page.getByText(/attempt \d+ of/)
      ).not.toBeVisible({ timeout: 5_000 });
    }
  );
});
