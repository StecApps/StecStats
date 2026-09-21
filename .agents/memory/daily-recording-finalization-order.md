---
name: Daily recording finalization order
description: Why Daily cloud recording shutdown must not depend on successful YouTube finalization.
---

Finalize the Daily cloud master independently before attempting YouTube broadcast finalization. If an import job cannot find a finished recording, reissue Daily's idempotent stop before retrying.

**Why:** An expired YouTube token repeatedly failed first and prevented the later Daily stop from running, leaving a game's recording unfinalized and unavailable to the importer.

**How to apply:** Any Live stop/finalizer path must preserve and stop the Daily master even when RTMP or YouTube cleanup fails. A database “stopped” status alone is not proof that Daily received the command.