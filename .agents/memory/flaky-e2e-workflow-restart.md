---
name: Flaky e2e failure from mid-test workflow restart
description: An e2e test can fail because the api-server workflow restarted mid-run, not because of an app bug — re-verify before treating it as a real regression.
---

Observed a Playwright e2e run report a Stripe Checkout button stuck disabled with no navigation and no error toast. Direct verification (calling the same Stripe API sequence from a script, then re-running the identical e2e test) showed the checkout flow itself worked correctly — the api-server workflow had auto-restarted (rebuild + restart cycle) right around the time of the click, causing the in-flight request to fail silently from the test's perspective.

**Why:** `pnpm run dev` for api-server does a full `build && start` on every restart (multi-second window with no listener), so any request that lands during that window looks like a hang/silent-failure to the test, not a clean HTTP error.

**How to apply:** When an e2e test reports a "button stuck / no error / no navigation" type failure with no corresponding error in current server logs, first check whether the api-server workflow log shows a restart around that timestamp. If so, re-run the test once before concluding there's a real bug. Don't chase phantom fixes (e.g. rewriting Stripe API calls) based on a single flaky run.
