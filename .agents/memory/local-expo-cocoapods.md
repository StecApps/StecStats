---
name: Local Expo CocoaPods workspace
description: Reliable handoff from Expo prebuild to a physical-device iOS build.
---

After Expo prebuild, the native project is not ready for Xcode until CocoaPods has completed successfully. A successful `pod install` creates the workspace that Xcode should use; opening the project file directly can produce sandbox/Podfile integration errors.

**Why:** The workspace contains the CocoaPods-generated dependencies and build configuration. Regenerating the native project after a manual Podfile repair can reintroduce generated-hook problems.

**How to apply:** Run prebuild once, run `pod install` from the iOS directory, open the generated `.xcworkspace`, and use Xcode for device testing and archiving. Avoid another prebuild until the native verification cycle is complete.