---
name: Clerk Apple strategy selection
description: Why StecStats uses Clerk Apple OAuth instead of the native Apple token helper.
---

Use Clerk’s `oauth_apple` SSO flow directly for StecStats. Do not use the native `oauth_token_apple` helper or manually reproduce its sign-in/sign-up transfer logic.

**Why:** The managed production Clerk instance advertises both strategies, but its native helper repeatedly failed during the production token exchange. The configured browser-based Apple OAuth flow reaches the managed shared Apple gateway and avoids that broken exchange.

**How to apply:** Start `oauth_apple` as a single-flight browser auth session and activate the returned session. Do not Promise-timeout-race the browser session, and do not add the native helper back as a first attempt or fallback.