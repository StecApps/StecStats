---
name: Clerk proxy Brotli responses
description: Why the production Clerk proxy must request identity-encoded responses for React Native clients.
---

The Clerk Frontend API proxy must override the upstream `Accept-Encoding` header to `identity`. Do not relay Brotli-compressed Clerk API bodies to React Native unchanged.

**Why:** Clerk compresses larger successful OAuth responses even when smaller environment and error responses stay uncompressed. On iOS, the proxied Brotli bytes can reach the Clerk client as text, causing a JSON parse error on an unexpected binary character.

**How to apply:** Set `Accept-Encoding: identity` on every upstream Clerk proxy request and preserve the proxy regression test. This is server-side and does not require a new native binary.