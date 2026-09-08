---
name: Native iPad full-screen support
description: Why the iOS app must be built as a native full-screen iPad app
---

Keep native iPad support enabled and require a full-screen iPad window.

**Why:** Running the app on iPad while declaring it iPhone-only left the root app window half-sized after the native video controller rotated and exited fullscreen.

**How to apply:** Do not disable tablet support to reduce App Store surface area. Preserve full-screen iPad configuration when changing Expo or iOS settings, and verify video fullscreen exit on a physical iPad.