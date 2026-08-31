---
name: Expo OTA runtime isolation
description: Why rebuilding native code may not escape a broken Expo update and how to create a safe recovery release.
---

When Expo uses the app version as its runtime version, every binary with that unchanged app version remains eligible for the same published or cached OTA update. Native rebuilds and JavaScript-engine changes do not isolate the new binary from that update.

**Why:** A physical-device startup abort symbolicated to Expo Updates error recovery after several rebuilt binaries continued selecting the same runtime. The repeated crashes were consistent with a failing OTA being relaunched and exhausting Expo's recovery pipeline.

**How to apply:** For a recovery binary, assign a new explicit runtime version and prevent update checks during startup so the embedded bundle launches first. Do not publish an update for the recovery runtime until the binary is verified.