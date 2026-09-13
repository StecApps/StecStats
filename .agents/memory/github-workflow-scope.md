---
name: GitHub workflow scope for TestFlight
description: Authentication constraint when adding or updating GitHub Actions release workflows.
---

GitHub credentials with repository access alone cannot create or update files under `.github/workflows`. The token must also belong to an account with write access to the target repository; correct scopes do not grant repository membership.

**Why:** GitHub rejected a release-branch push even though ordinary repository writes worked; both the stored personal token and the OAuth connector lacked the separate workflow permission. A replacement token with broad scopes was also rejected because its account had read-only repository access.

**How to apply:** Before promising a GitHub-triggered TestFlight build, verify token identity, repository push permission, and workflow-file permission. A classic token needs `repo` plus `workflow`; a fine-grained token needs repository contents and workflows write access. `workflow_dispatch` only recognizes workflows present on the default branch; for a release-only workflow, use a matching push trigger or first place the workflow on the default branch.