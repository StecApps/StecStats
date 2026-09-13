---
name: TestFlight build-number continuity
description: Keep iOS release build numbers monotonic across GitHub and direct EAS builds.
---

Use the app's explicit local eight-digit iOS build-number sequence for production builds. GitHub production builds must not use EAS auto-increment because an ephemeral runner cannot persist the increment back to the repository.

**Why:** GitHub-generated TestFlight builds had numbers in the `202608xx` range, while direct EAS builds used `81` and `82`. Later, two GitHub runs both read the same local build number and auto-incremented to the same next value; the second IPA built successfully but Apple rejected it as already submitted.

**How to apply:** Keep `appVersionSource` local, disable production auto-increment, and commit a build-number bump before every production build. Compare that explicit number with the newest App Store Connect/TestFlight build before triggering CI.