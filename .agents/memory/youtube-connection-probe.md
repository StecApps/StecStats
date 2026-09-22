---
name: YouTube connection status must probe Google
description: Why a stored YouTube refresh token is not sufficient proof that Live is connected.
---

Every user-facing YouTube connection status must validate the stored refresh token with a bounded Google API probe. Token presence alone must not render “Connected.” A Google 403 is not automatically an authentication failure.

**Why:** Google can revoke or expire a refresh token while the encrypted database value remains. Profile then showed “YouTube Connected,” but Live correctly failed when it made a real YouTube API request. Conversely, a newly issued valid token can receive a 403 because Live is disabled, quota is exhausted, or the channel is restricted; treating every 403 as revoked creates a reconnect loop.

**How to apply:** Use a lightweight authenticated YouTube request with a short timeout. Clear the stored token only on a 401 or an explicit Google auth reason. Read Google reasons from both top-level errors and nested response data. Preserve tokens for channel, quota, and service failures. Mark status responses `no-store` and ignore incoming cache validators.