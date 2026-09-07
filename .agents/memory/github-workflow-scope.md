---
name: GitHub workflow scope for TestFlight
description: Authentication constraint when adding or updating GitHub Actions release workflows.
---

GitHub credentials with repository access alone cannot create or update files under `.github/workflows`.

**Why:** GitHub rejected a release-branch push even though ordinary repository writes worked; both the stored personal token and the OAuth connector lacked the separate workflow permission.

**How to apply:** Before promising a GitHub-triggered TestFlight build, verify the credential can write Actions workflows. A classic token needs `repo` plus `workflow`; a fine-grained token needs repository contents and workflows write access. If the verified source is already ready and the user approves, the same production EAS build can be started directly with the securely stored Expo token.