---
name: EAS Update production environment
description: Production OTAs must load both EAS server variables and the production build-profile environment.
---

Publish production mobile OTAs through the guarded project release command, not a bare `eas update`.

**Why:** `eas update --environment production` loads server-defined EAS variables but does not apply values from `build.production.env` in `eas.json`. An OTA therefore shipped the live Clerk key without the required proxy and API domain, breaking all production sign-in methods.

**How to apply:** Keep production-public variables in the build profile and use the project release command, which merges that profile into the process and also selects the EAS production environment. Verify the exported bundle contains the expected domain and proxy before considering the update complete.