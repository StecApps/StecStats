# Manual Test: Coach Camera Survives Server Restart

**Requires:** A real phone or laptop with camera access, and a second device/browser tab to act as the viewer.

---

## What this tests

When the api-server restarts mid-game (deploy, crash, etc.):
1. The **coach's local recording** keeps running uninterrupted (MediaRecorder/IndexedDB is browser-local, independent of the server)
2. The **live broadcast automatically reconnects** — no action needed from the coach for the first ~50 seconds
3. The **viewer's watch page** transitions through `waiting-for-broadcaster` and resumes video once the coach reconnects — no new link required
4. If auto-reconnect exhausts all retries, the coach can tap **Go Live** again to re-broadcast on the **same invite code**

---

## Pre-conditions

- The app is running (production or `pnpm --filter @workspace/hoops-stats run dev`)
- Coach has a Pro or Premium account (live streaming requires Pro)
- Two devices/tabs available: **Broadcaster** (phone with camera) and **Viewer** (any browser)

---

## Test Steps

### Step 1 — Start a live stream

1. Open `/record` on the **Broadcaster** device
2. Select a team, set opponent name, tap **Start Recording**
3. Confirm camera preview appears and the timer starts counting
4. Tap **Go Live** — wait for the invite code to appear (e.g. `ABCD12`)
5. On the **Viewer** device, open `/watch/ABCD12`
6. Confirm the viewer sees the live camera feed and scoreboard

### Step 2 — Restart the api-server mid-stream

7. In the Replit workspace, restart the **API Server** workflow (or run `kill $(lsof -ti:PORT)` in a shell)
8. Watch the **Broadcaster** device — you should see:
   - 🟡 **"Reconnecting live stream…"** banner appears within ~2 seconds
   - **"Your recording keeps going. The broadcast will resume automatically once reconnected."**
   - The recording timer **continues ticking** — the camera feed is uninterrupted
9. Watch the **Viewer** device — you should see:
   - Video freezes and the page shows **"Broadcaster disconnected"** or **"Waiting for broadcaster…"**
   - The viewer stays on the same `/watch/ABCD12` page — no redirect, no error screen

### Step 3 — Confirm auto-reconnect

10. Once the api-server is back up (~5–10 seconds), the **Broadcaster** device should show:
    - The amber banner disappears
    - Toast: **"Live stream reconnected — The broadcast has resumed."**
    - `isLive` status dot is back (green/red dot next to viewer count)
11. On the **Viewer** device:
    - Video resumes (may require ~5 seconds for ICE to re-establish)
    - No new link was needed

### Step 4 — Verify recording is unaffected

12. Back on the **Broadcaster** device, tap **Stop Recording** and then **Save Game**
13. Confirm the saved game has a **complete video** (no gap at the server-restart timestamp)
14. Check the timeline in Film Room — the stat events before and after the restart should align correctly

---

## Step 5 — Interrupted state (optional, exhausts retries)

If you want to verify the final fallback UI:

15. Restart the server repeatedly within 50 seconds so all 6 reconnect attempts fail
16. The coach should see:
    - 🔴 **"Live stream interrupted"** banner
    - **"Your recording is still safe. Tap 'Go Live' to start broadcasting again with the same invite link."**
17. Tap **Go Live** — confirm it reuses the **same invite code** (`ABCD12`) — no new code is generated
18. On the **Viewer** device, confirm the stream resumes on the same `/watch/ABCD12` URL

---

## Expected results summary

| Scenario | Coach recording | Coach UI | Viewer |
|---|---|---|---|
| Server restarts, comes back in <50s | ✅ Uninterrupted | Amber "Reconnecting…" → resolved toast | Waits → resumes automatically |
| Server never comes back (retries exhausted) | ✅ Uninterrupted | Red "Interrupted" + "Go Live" button | Stuck on waiting-for-broadcaster |
| Coach taps Go Live after interrupted | ✅ Uninterrupted | Live again with same code | Resumes on same URL |

---

## What NOT to test here

- Highlight/lowlight reel generation — that is a separate upload pipeline
- Video upload failure recovery — covered by `background-upload` tests
- TURN relay availability — covered by the TURN expiry warning tests

---

## Notes

- Auto-reconnect uses exponential backoff: 1s → 2s → 4s → 8s → 8s → 8s (6 total attempts, ~31s total)
- The invite code is persisted to the `live_sessions` database table so it survives a server restart
- Server-side: `getOrResumeSession()` in `liveStream.ts` transparently recreates the in-memory session from DB after a restart — the coach and viewer rejoin the **same** session object
- Relevant code: `artifacts/hoops-stats/src/pages/record.tsx` (`connectBroadcasterSocket`, `goLive`), `artifacts/api-server/src/lib/liveSocket.ts`, `artifacts/api-server/src/lib/liveStream.ts` (`getOrResumeSession`)
