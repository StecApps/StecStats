---
name: EAS Update production environment
description: Production OTAs must load both EAS server variables and the production build-profile environment.
---

Publish production mobile OTAs through the guarded project release command, not a bare `eas update`. Treat authentication-related OTAs as unverified until they pass a physical-device sign-in check.

**Why:** `eas update --environment production` loads server-defined EAS variables but does not apply values from `build.production.env` in `eas.json`. An OTA therefore shipped the live Clerk key without the required proxy and API domain, breaking all production sign-in methods. A replacement bundle containing the expected values still left Clerk initialization blocked on-device, so string-presence checks alone are insufficient.

**How to apply:** Keep production-public variables in the build profile and use the project release command, which merges that profile into the process and also selects the EAS production environment. Verify the exported bundle, then test Apple and email sign-in on a physical TestFlight device before leaving the OTA on production. If Clerk remains unloaded, roll the channel back to the known-good embedded bundle.