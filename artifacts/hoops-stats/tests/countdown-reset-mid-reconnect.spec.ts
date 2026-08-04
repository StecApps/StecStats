/**
 * countdown-reset-mid-reconnect.spec.ts
 *
 * Confirms that the reconnect countdown resets correctly when a second
 * ws.onclose fires before the previous retry timer has run.  This edge case
 * arises when the signaling server restarts in a fast loop: the first drop
 * schedules a retry in Xms, but the reconnect itself fails immediately,
 * writing a new retryAt timestamp.  The UI must show the new countdown and
 * the internal tick interval must not accumulate duplicate timers.
 *
 * Two surfaces:
 *
 *   A) watch.tsx (viewer side) — exercised via the real WebSocket mock:
 *        connection 1 → close immediately → "Attempt 1 of 6" + "next attempt in 1s"
 *        connection 2 → close immediately → "Attempt 2 of 6" + "next attempt in 2s"
 *      Verifies that after the second drop:
 *        • reconnectRetryAtRef was overwritten → countdown shows the new (2 s) delay
 *        • only one tick interval is running → countdown drops ≤ 1 per 900 ms
 *
 *   B) record.tsx (broadcaster side) — exercised via the dev hook
 *      __hoopsSimulateLiveReconnectDrop(attempt, delayMs), which mirrors the
 *      real ws.onclose path including overwriting liveReconnectRetryAtRef.
 *        call 1 → "attempt 1 of …" + "next attempt in 1s"
 *        call 2 → "attempt 2 of …" + "next attempt in 2s"
 *      Same countdown-reset and no-duplicate-tick assertions.
 *
 * What is mocked vs exercised
 * ---------------------------
 * Mocked  : HTTP health-gate, live session status, ICE servers, WS signaling,
 *           RTCPeerConnection, Clerk auth (test B)
 * Exercised: watch.tsx / record.tsx state machines, reconnect refs, countdown
 *            useEffect logic, UI rendering of attempt counter + countdown text
 */

import { test, expect } from "@playwright/test";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const WATCH_CODE = "CDRST1";
const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY ?? "";

// Minimal FakePeerConnection so no real WebRTC failures pollute state.
// These tests only exercise the WS-level reconnect path, not ICE, so the PC
// just needs to exist without doing anything harmful.
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
    async setRemoteDescription(_d) {}
    async createAnswer() { return { type: "answer", sdp: "v=0\\r\\n" }; }
    async setLocalDescription(_d) {}
    addIceCandidate() { return Promise.resolve(); }
    close() { this._closed = true; this.connectionState = "closed"; }
  }
  window.RTCPeerConnection = FakePeerConnection;
})();
`;

// ---------------------------------------------------------------------------
// Test A — watch.tsx viewer-side countdown reset
// ---------------------------------------------------------------------------

test.describe("Watch page – countdown resets when a second drop fires mid-countdown", () => {
  test(
    "second ws.onclose updates retryAtRef and the countdown jumps to the new delay; single interval",
    async ({ page }) => {
      await page.addInitScript({ content: FAKE_PC_SCRIPT });

      // ── HTTP stubs ──────────────────────────────────────────────────────────

      await page.route(
        (url) => url.pathname === "/api",
        (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
      );

      await page.route(
        (url) => url.pathname === `/api/live/${WATCH_CODE}/status`,
        (route) =>
          route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              active: true,
              opponent: "Rivals",
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
      // Drop every connection immediately after the join ack.
      //   Connection 1 drop → attempt index 0 → delay 1 000 ms → countdown ~1 s
      //   Connection 2 drop → attempt index 1 → delay 2 000 ms → countdown ~2 s
      // Never send an offer so the component never leaves "reconnecting".

      await page.routeWebSocket(
        (url) => url.pathname === "/api/live/ws",
        (ws) => {
          ws.onMessage((raw) => {
            let msg: Record<string, unknown>;
            try {
              msg = JSON.parse(
                typeof raw === "string" ? raw : new TextDecoder().decode(raw as ArrayBuffer)
              );
            } catch {
              return;
            }
            if (msg.type === "join-viewer") {
              // Acknowledge the join so the component clears the "connecting" state,
              // then close the socket to trigger ws.onclose → "reconnecting".
              ws.send(JSON.stringify({ type: "joined", viewerId: "test-viewer-cdrst" }));
              setTimeout(() => ws.close(), 60);
            }
          });
        }
      );

      await page.goto(`/watch/${WATCH_CODE}`);

      // ── 1. Component enters "connecting" ───────────────────────────────────
      await expect(page.getByText(/Joining the stream/)).toBeVisible({ timeout: 10_000 });

      // ── 2. First drop → attempt 1 with 1 s countdown ──────────────────────
      await expect(page.getByText(/Attempt 1 of 6/)).toBeVisible({ timeout: 5_000 });
      // delay[0] = 1 000 ms → countdown should read 1s shortly after the drop.
      await expect(page.getByText(/next attempt in 1s/)).toBeVisible({ timeout: 3_000 });

      // ── 3. Second drop → attempt 2 with 2 s countdown ─────────────────────
      // The 1 000 ms timer fires, opens connection 2, which also drops immediately.
      // reconnectRetryAtRef must be overwritten to Date.now() + 2 000.
      await expect(page.getByText(/Attempt 2 of 6/)).toBeVisible({ timeout: 5_000 });

      // After the second drop the countdown must reset to ~2 s (delay index 1),
      // NOT continue from 1 s as if still counting down the first attempt.
      await expect(page.getByText(/next attempt in 2s/)).toBeVisible({ timeout: 3_000 });

      // ── 4. Single-interval check (no duplicate ticks) ─────────────────────
      // Two overlapping setInterval(1 000 ms) would decrement the countdown by
      // 2 per second.  Read the counter twice, 900 ms apart; delta must be ≤ 1.
      const textBefore = await page.getByText(/next attempt in \d+s/).textContent();
      await page.waitForTimeout(900);
      const textAfter = await page.getByText(/next attempt in \d+s/).textContent();

      const extract = (t: string | null) =>
        parseInt((t ?? "0").replace(/[^0-9]/g, ""), 10);
      const before = extract(textBefore);
      const after  = extract(textAfter);

      // Allow for the normal single-interval tick (≤ 1 s drop) plus 1 for
      // timing jitter — but never 2+ which would indicate duplicate intervals.
      expect(before - after).toBeLessThanOrEqual(1);
    }
  );
});

// ---------------------------------------------------------------------------
// Test B — record.tsx broadcaster-side countdown reset
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
    throw new Error(`Failed to create Clerk user: ${res.status} ${await res.text()}`);
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
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test-cdrst.example.com`;
}

test.describe("Record page – countdown resets when a second drop fires mid-countdown", () => {
  let userId: string;
  const email = uniqueEmail("cdrst-rec");
  const password = "CdrstRecordTest!9x";

  test.beforeAll(async () => {
    const user = await createClerkUser(email, password);
    userId = user.id;
  });

  test.afterAll(async () => {
    if (userId) await deleteClerkUser(userId);
  });

  test(
    "__hoopsSimulateLiveReconnectDrop called twice resets attempt counter and countdown; single interval",
    async ({ page }) => {
      await setupClerkTestingToken({ page, userId });

      // ── HTTP stubs ──────────────────────────────────────────────────────────
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
      await expect(page.getByText("Live stream link")).toBeVisible({ timeout: 15_000 });

      // ── 1. First drop: attempt 1, delay 1 000 ms ──────────────────────────
      await page.evaluate(() =>
        (window as any).__hoopsSimulateLiveReconnectDrop(1, 1000)
      );

      await expect(page.getByText(/Reconnecting live stream/)).toBeVisible({ timeout: 5_000 });
      await expect(page.getByText(/attempt 1 of/)).toBeVisible({ timeout: 5_000 });
      // delay 1 000 ms → countdown shows 1 s.
      await expect(page.getByText(/next attempt in 1s/)).toBeVisible({ timeout: 3_000 });

      // ── 2. Second drop mid-countdown: attempt 2, delay 2 000 ms ──────────
      // Simulates the reconnect firing and the new connection also dropping
      // before the first tick interval has finished counting down.
      await page.evaluate(() =>
        (window as any).__hoopsSimulateLiveReconnectDrop(2, 2000)
      );

      // Attempt counter must update — it should not be stuck at 1.
      await expect(page.getByText(/attempt 2 of/)).toBeVisible({ timeout: 5_000 });

      // Countdown must reset to ~2 s (the new delay), confirming that
      // liveReconnectRetryAtRef was overwritten and the existing interval
      // picks up the new value on its next tick.
      await expect(page.getByText(/next attempt in 2s/)).toBeVisible({ timeout: 3_000 });

      // ── 3. Single-interval check ──────────────────────────────────────────
      // If two intervals were running the countdown would drop by 2 per second.
      const textBefore = await page.getByText(/next attempt in \d+s/).textContent();
      await page.waitForTimeout(900);
      const textAfter = await page.getByText(/next attempt in \d+s/).textContent();

      const extract = (t: string | null) =>
        parseInt((t ?? "0").replace(/[^0-9]/g, ""), 10);
      const before = extract(textBefore);
      const after  = extract(textAfter);

      expect(before - after).toBeLessThanOrEqual(1);
    }
  );
});
