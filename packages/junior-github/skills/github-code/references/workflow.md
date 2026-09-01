# Edit and PR packaging

Open this when making repository edits, not for read-only inspection.

## Resolve and inspect

1. Identify repo, checkout, branches, worktree, package manager, and relevant checks.
2. Prefer an existing checkout or matching Workspace; otherwise clone shallowly.
3. If clone returns a Workspace match error, switch Workspace or pass `allowAdHoc=true`.
4. Shallow clones are for fast inspection. Before rebase, merge-base, blame, or base comparison, fetch/deepen the needed refs. Never force-push around missing history.
5. For edits, pick the smallest credible validation path. Capture a baseline when a failure may be pre-existing.

## Investigate

1. Find where the behavior lives, current vs requested, root cause or gap, and the smallest proof.
2. Read linked issues, PRs, specs, and failing output when provided.
3. For PRs, inspect conversation, inline comments, reviews, diff, and checks.
4. Investigation-only requests: report evidence; do not edit.

## Edit

1. Make the smallest coherent change. Follow local patterns. Avoid speculative cleanup.
2. After a failed attempt, re-check root cause before patching again.
3. Before repo checks, ensure dependencies with the lockfile-native frozen install. Do not rewrite the lockfile unless dependency changes are part of the task.

## Verify

1. Run targeted changed-file/package checks before broad suites.
2. Separate regressions from baseline failures.
3. Instruction-only changes: structural checks plus content review.

## Package

1. Reuse the current non-default branch or create a focused branch.
2. Commit with repo conventions, else `<type>(<scope>): <Subject>` imperative present, no agent branding.
3. Push with `git push -u origin BRANCH`.
4. Resolve the actual default branch.
5. Update an existing PR for the branch with `github_updatePullRequest`, or create with `github_createPullRequest` (`draft: true` unless ready-for-review is required).
6. PR title matches the current dominant change, same conventional form as commits.
7. PR body: short, plain English, what changed and why. Only context the diff cannot show. No empty sections, file lists, commit logs, or Checks/Verification/Test plan blocks. Put local check results in the user report only.
8. After material follow-up commits, refresh title and body against the current diff.
9. Never put customer data, PII, secrets, or sensitive thread context in public PR text.
10. If PR create/update is blocked, report the exact failure and leave the committed branch intact.

## Follow

When PR creation returns a subscribable hint, subscribe to suggested review/CI events. Report only actionable feedback fixed, build failures fixed, green/ready, or merge.
