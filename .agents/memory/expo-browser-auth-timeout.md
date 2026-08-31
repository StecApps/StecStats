---
name: Expo browser auth timeout
description: Constraint for timeout handling around Expo WebBrowser authentication sessions.
---

Do not wrap an Expo `openAuthSessionAsync`-backed SSO flow in a generic Promise timeout. A timeout only stops awaiting the Promise; it does not close the native browser session. Keep the flow single-flight until Expo reports success, cancellation, or failure.

**Why:** A timed-out Apple SSO fallback left its browser session open. Retrying then failed with “Another web browser is already open.”

**How to apply:** Generic timeouts remain appropriate for ordinary Clerk network requests, but browser-based OAuth/SSO handlers need an immediate in-progress guard and must await the real browser result.