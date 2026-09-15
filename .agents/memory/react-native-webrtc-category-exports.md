---
name: React Native category export gap
description: Why compiling a react-native-webrtc Objective-C category does not prove custom bridge methods are visible to JavaScript.
---

Custom React Native bridge methods added only through an Objective-C category may compile and link successfully but still be absent from `NativeModules` under legacy-module interop.

**Why:** A physical TestFlight build contained the expected pnpm patch hash and compiled the modified category, yet feature detection still found no custom shared-camera methods and viewers stayed score-only.

**How to apply:** For custom `react-native-webrtc` bridge additions, register stable forwarding exports on the primary module implementation. In release logs, verify both the patched pnpm path and compilation of the primary module source; category compilation alone is insufficient.