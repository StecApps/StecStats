---
name: TestFlight build-number continuity
description: Keep iOS release build numbers monotonic across GitHub and direct EAS builds.
---

Use the app's local eight-digit iOS build-number sequence for production builds. Do not switch production back to EAS's independent remote counter unless that counter is first raised above every build already uploaded to App Store Connect.

**Why:** GitHub-generated TestFlight builds had numbers in the `202608xx` range, while direct EAS builds used `81` and `82`. Those uploads succeeded but TestFlight did not present them as newer than the installed eight-digit build. EAS also returned repeated GraphQL errors when asked to raise its remote counter.

**How to apply:** Keep `appVersionSource` local and production auto-increment enabled. Before starting a release, compare the resulting iOS build number with the newest App Store Connect/TestFlight build.