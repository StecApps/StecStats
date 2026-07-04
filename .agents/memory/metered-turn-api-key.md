---
name: Metered.ca TURN credential-scoped API key
description: Which Metered.ca key to use for the turn/credentials REST endpoint, and how to tell if a user pasted the wrong one.
---

Metered.ca's TURN server product has three different key types (credential-scoped `apiKey`, account `secretKey`, `projectKey`). Only the credential-scoped `apiKey` works with `GET https://<domain>/api/v1/turn/credentials?apiKey=...` — it's found in the dashboard under the specific TURN Credential's "Show API Key" button, not the account settings page.

**Why:** A user initially supplied a key from the wrong dashboard section (or copy-pasted an unrelated value) and the endpoint returned `401 {"error":"Invalid API Key"}` even though the URL/domain format was correct. The URL/params were not the problem — the key was.

**How to apply:** If Metered's `turn/credentials` endpoint 401s with a correctly-formed URL (`https://<appname>.metered.live/api/v1/turn/credentials?apiKey=...`), don't assume the integration code is wrong — ask the user to re-check they copied the *credential-scoped* API key (safe for frontend use), not the secret/project key.
