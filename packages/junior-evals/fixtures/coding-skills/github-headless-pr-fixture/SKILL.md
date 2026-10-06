---
name: github-headless-pr-fixture
description: Use for work on the local checkout of GitHub pull request getsentry/junior#691, such as a fix for its failed checks.
---

# Headless Pull Request Fixture

The branch of GitHub pull request getsentry/junior#691 is checked out at
`skills/github-headless-pr-fixture/project`. Its remote is a local bare Git
repository, so a push needs no GitHub authorization. Do not clone the
repository from GitHub.

The `test` check fails while `project/src/status.ts` exports
`buildStatus = "broken"`. It passes when the file exports
`buildStatus = "fixed"`.

To fix a failed check, run `setup.sh`, fix the failure in the project, commit
and push the existing branch, then run `verify.sh`.
