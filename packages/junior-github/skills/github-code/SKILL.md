---
name: github-code
description: Work with GitHub repositories, source code, branches, commits, pull requests, reviews, diffs, CI, and repository credentials. Use for implementation, source investigation, clone/fetch/branch workflows, PR creation or updates, review feedback, GitHub Actions checks, and repository permission failures. Prefer this skill for repository tasks even when they concern a Sentry product.
---

# GitHub Code Operations

Use `git` and `gh` for repository work. Use `github_createPullRequest`, not `gh pr create`, for new PRs.

## References

| Open when you need                     | Read                                                                                   |
| -------------------------------------- | -------------------------------------------------------------------------------------- |
| Command syntax, permissions, config    | [references/api-surface.md](references/api-surface.md)                                 |
| Failed commands or permission recovery | [references/troubleshooting-workarounds.md](references/troubleshooting-workarounds.md) |

## Non-negotiable rules

- Resolve the repo from the explicit request, then `github.repo`. Run `jr-rpc config get github.repo` standalone.
- Keep `--repo owner/repo` explicit on `gh`; use `git -C PATH` for local repos.
- Read applicable `AGENTS.md` files before editing. Narrower repo/task instructions win.
- Preserve unrelated work. Never force-push, delete refs, or perform destructive merges.
- Base conclusions on repository evidence. Do not claim a check ran unless it did.
- Supported App-owned writes use an automatically injected repository-scoped credential. Try the operation before requesting remediation; ask for no user token.
- Stop for ambiguous targets, missing access, destructive operations, or unresolved upstream permission failures.

## Workflow

### 1. Resolve and inspect

Identify the repo, checkout, default/current branches, worktree state, repo instructions, package manager, and relevant checks. Prefer an existing checkout; otherwise clone shallowly.

A shallow clone is for fast inspection, not history rewriting. Before rebasing, merge-base analysis, blame/history work, or comparing against a base absent locally, fetch the needed refs and deepen incrementally. Use `--unshallow` only when bounded deepening is insufficient. Never use a force push to compensate for incomplete history.

For edits, choose the smallest credible validation path before changing files. Capture a baseline when a failure may be pre-existing.

### 2. Investigate

Establish where the behavior lives, current versus requested behavior, root cause or gap, and the smallest proof of correctness. Read linked issues, PRs, specs, and failing output when provided. If the request is investigation-only, report evidence without editing.

For non-trivial architecture, API, security, concurrency, migration, or broad cross-file work, use the available advisor after gathering evidence and before editing. Resolve material concerns in the plan.

### 3. Edit

Make the smallest coherent change. Follow local patterns and avoid speculative cleanup. After a failed attempt, re-check the root cause before patching again.

Before running repo checks, ensure project dependencies are available:

1. Detect the package manager and lockfile from repo evidence.
2. If dependencies are missing or the check reports missing packages, run the repo-native frozen/immutable install (`pnpm install --frozen-lockfile`, `npm ci`, `yarn install --immutable`, `bun install --frozen-lockfile`, or the documented equivalent).
3. Do not regenerate or modify a lockfile merely to make verification run. If the locked install fails, report the exact failure unless dependency changes are part of the task.

Do not install or repair the GitHub plugin runtime itself; that is manifest-owned setup.

### 4. Verify and review

Run targeted changed-file/package checks before broad suites. Separate regressions from baseline failures. For instruction-only changes, run available structural checks and perform a content-consistency review.

For non-trivial work, review the final diff and initial results with the available advisor before packaging. Address material correctness, regression, and testing concerns, then rerun affected checks.

### 5. Package every completed edit

Unless the user explicitly says not to create a PR, every completed repository edit must end in a pushed branch and PR. Default to draft; honor an explicit user or repo instruction to open it ready for review. Do not stop at local changes or a commit.

1. Reuse the current non-default branch or create a focused branch.
2. Commit using repo conventions; otherwise use `<type>(<scope>): <Subject>` in imperative present tense, with no agent branding.
3. Push explicitly with `git push -u origin BRANCH`.
4. Resolve the actual default branch.
5. Reuse and update an existing PR for the branch; otherwise call `github_createPullRequest` with explicit repo, head, base, title, body, and `draft: true` unless the user or repo explicitly requires ready-for-review.

The PR body should explain what changed and why, checks run, and remaining risks or unverified areas. Never include customer data, PII, secrets, or sensitive thread context, especially in public repositories. Re-evaluate its title/body after material follow-up commits. Resolve requested assignee/reviewer handles from evidence; skip unconfirmed identities.

If PR creation is blocked, report the exact failed command/tool call and leave the committed branch intact.

### 6. Follow and report

When PR creation returns a subscribable resource hint, subscribe to suggested review/CI events. Report only actionable feedback addressed, build failures fixed, fully green/ready state, or merge.

Return: repo, branch, PR URL/number, checks and results, pre-existing failures, and anything not run with the reason.

## Operation notes

- **Clone/history:** clone shallowly by default; deepen before any operation that relies on omitted ancestry.
- **PR inspection:** read conversation comments, inline review comments, reviews, diff, and checks.
- **PR mutation:** push before create; use only supported endpoints in the API reference.
- **Workflow dispatch:** `gh workflow run` is supported only for workflows declaring `workflow_dispatch`.
- **Permissions:** a tool-routing denial requires the named tool; only an upstream denial justifies permission remediation.
