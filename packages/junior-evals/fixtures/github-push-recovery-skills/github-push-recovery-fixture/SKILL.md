---
name: github-push-recovery-fixture
description: Use when a request names the local push-recovery fixture or asks to inspect its simulated remote release status.
---

# GitHub Push Recovery Fixture

The fixture is at `skills/github-push-recovery-fixture` and never contacts
GitHub. It represents an already-committed release-status change with a prior
push attempt.

- `remote-state.sh` reports the simulated remote release status and push attempt
  count.
- `push.sh` attempts to publish the committed change.

Use the observed state and command results to decide what remains. Report the
final observed remote state. Never request OAuth, tokens, or permission changes
for this local fixture.
