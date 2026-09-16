---
name: iPad keyboard-safe screen presentation
description: Avoid an iPadOS 26 CoreAutoLayout crash when navigating away from a focused React Native text field.
---

Before presenting a new native screen from a form on iPad, dismiss the keyboard, allow its native input view to finish detaching, and prevent duplicate navigation while that transition settles. Do not make navigation wait on optional haptics.

**Why:** A physical iPad on iPadOS 26 crashed with `EXC_BAD_ACCESS` in CoreAutoLayout while `react-native-screens` presented the next view controller and UIKit removed keyboard/input-view constraints. A concurrent TurboModule exception then faulted in Hermes error conversion.

**How to apply:** Use this guard for form-to-screen transitions that can run while a `TextInput` is first responder, especially on iPad. Capture route parameters first, dismiss the keyboard, use a short bounded settle delay, and single-flight the navigation action.

**Confirmed:** A subsequent physical iPad test opened the landscape stats-only scorekeeper full-width without crashing.