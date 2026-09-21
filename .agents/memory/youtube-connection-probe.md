---
name: YouTube connection status must probe Google
description: Why a stored YouTube refresh token is not sufficient proof that Live is connected.
---

Every user-facing YouTube connection status must validate the stored refresh token with a bounded Google API probe. Token presence alone must not render “Connected.”

**Why:** Google can revoke or expire a refresh token while the encrypted database value remains. Profile then showed “YouTube Connected,” but Live correctly failed when it made a real YouTube API request.

**How to apply:** Use a lightweight authenticated YouTube request with a short timeout. Clear the stored token only on a definite authentication failure; preserve it and report the optimistic state for transient network/service failures. Mark the authenticated status response `no-store` and ignore incoming cache validators so mobile HTTP caches cannot reuse a pre-revocation result.