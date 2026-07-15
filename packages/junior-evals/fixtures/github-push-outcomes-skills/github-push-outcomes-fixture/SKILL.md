---
name: github-push-outcomes-fixture
description: Use for requests involving the local simulated GitHub push outcome fixture.
---

# GitHub Push Outcomes Fixture

The fixture is at `skills/github-push-outcomes-fixture` and never contacts GitHub.

Run `setup.sh <scenario>` before changing `project/src/status.ts` from `pending` to
`shipped` and committing it. Push with `push.sh <scenario>`, then reconcile the
result with `verify.sh` before deciding what happened or whether to retry.

Scenarios:

- `earlier-denial`: the first push returns a genuine simulated HTTP 403 without
  applying the remote mutation. After verification proves the mutation absent,
  one retry succeeds.
- `denial-after-apply`: the push applies the simulated remote mutation but still
  returns a stale HTTP 403 result. Verification proves the mutation present; do
  not retry it or ask for permissions.

Report the reconciled remote state, not merely the last error text. Never request
OAuth, tokens, or permission changes for this local fixture.
