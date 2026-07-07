---
name: runTest requires testClerkAuth flag for [Clerk Auth] test steps
description: Omitting testClerkAuth:true from runTest() while using a [Clerk Auth] step makes the sign-in hit Clerk's real hosted UI instead of programmatic login, which can be blocked by Cloudflare bot/PAT challenges and looks like a random app bug.
---

Ran a test plan with `[Clerk Auth] Sign in as {...}` steps but forgot to pass `testClerkAuth: true` to `runTest()`. The sign-up silently failed against Clerk's real UI (Cloudflare "Private Access Token challenge" / 401s in browser console), no user row was ever created in the DB, and the app correctly fell back to the signed-out marketing page — which read like a routing/gating bug in the app.

**Why:** The `[Clerk Auth]` test-plan tag only activates programmatic sign-in when `testClerkAuth: true` is passed as a top-level argument to `runTest()`. Without it, the testing subagent tries to drive Clerk's actual hosted sign-in/sign-up UI in a headless browser, which trips Clerk's bot protection.

**How to apply:** Whenever a test plan includes `[Clerk Auth]` steps, double-check the `runTest()` call includes `testClerkAuth: true`. If a Clerk-auth-gated test fails with Cloudflare/401/PAT errors or the user ends up signed-out unexpectedly, check this flag before assuming an app bug. Also note: a single flaky run right after fixing the flag isn't necessarily a real bug either — re-run once before chasing a fix (see flaky-e2e-workflow-restart.md for the general pattern).
