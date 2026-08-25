---
name: Account deletion tombstones
description: Safe retry behavior when account data, object storage, and Clerk identity cannot be deleted atomically.
---

Use a durable deletion-pending marker before any irreversible account cleanup. While marked, reject ordinary authenticated requests and allow only the deletion retry path. Purge application data into a scrubbed local tombstone, delete the Clerk identity afterwards, then remove the tombstone only after that succeeds. Do not report final deletion until all previously issued direct-upload signed URLs have expired and a final owner-namespace sweep has completed.

**Why:** Object storage, the database, and Clerk do not participate in one transaction. Returning a hard failure after one side has been erased either misleads the coach or strands private data behind an undeletable identity.

**How to apply:** Keep background media writers blocked for pending owners, wait for in-flight processors before the namespace sweep, and use an accepted/pending outcome after the marker has been set so the client can sign out and safely retry later. GCS signed PUTs are not revocable: retain the pending state through their full TTL, then make the retry perform the final sweep before the 204 result.