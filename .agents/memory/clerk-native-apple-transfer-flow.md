---
name: Clerk native Apple transfer flow
description: Why native Apple authentication must use Clerk’s supported Expo helper rather than a manual token exchange.
---

Use Clerk’s native Apple authentication helper exported from `@clerk/expo/apple`. Do not manually call the legacy Apple token strategy and reproduce sign-in/sign-up transfer logic.

**Why:** A valid native Apple credential for a new user can be rejected with HTTP 403 when a custom flow attempts sign-in before establishing or transferring the sign-up. Clerk’s helper owns secure nonce generation and the sign-up-versus-existing-account transfer sequence.

**How to apply:** For native iOS Apple login, call the helper and activate its returned session. Keep direct legacy sign-in/sign-up APIs only for flows not yet migrated to Clerk’s current API.