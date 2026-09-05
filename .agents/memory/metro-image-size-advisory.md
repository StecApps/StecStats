---
name: Metro image-size advisory
description: Why Metro uses a local image dimension parser instead of the vulnerable upstream package.
---

The public `image-size` package has two infinite-loop advisories affecting every published version through 2.0.2, with no patched npm release. Keep Metro resolved to the bounded local parser until a genuinely patched upstream release is available.

**Why:** Upgrading from 1.x to the latest public version does not remediate the ICNS and HEIF/JXL denial-of-service paths, so a normal version override leaves the audit vulnerable.

**How to apply:** When updating Expo or Metro, verify dependency resolution still selects the local parser and run its malformed-input tests. Before returning to upstream, confirm the advisory reports a patched version and test all mobile asset formats in use.