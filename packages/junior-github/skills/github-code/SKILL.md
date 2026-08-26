---
name: github-code
description: Work with GitHub repositories, source code, branches, commits, pull requests, reviews, diffs, CI, and repository credentials. Use for implementation, source investigation, clone/fetch/branch workflows, PR creation or updates, review feedback, GitHub Actions checks, and repository permission failures. Prefer this skill for repository tasks even when they concern a Sentry product.
---

# GitHub Code Operations

Use `git` and `gh` for repository work.

| Action | Tool / command |
| --- | --- |
| Create PR | `github_createPullRequest` (not `gh pr create`) |
| Update PR title/body/base/state | `github_updatePullRequest` (not raw PATCH / `gh pr edit`) |
| Resolve review thread | `github_resolvePullRequestReviewThread` (not raw GraphQL) |
| Clone missing repo | `github_cloneRepository`; on Workspace match error use `switchWorkspace` |

## Open when needed

| Need | Read |
| --- | --- |
| Commands, permissions, allowlist | [references/api-surface.md](references/api-surface.md) |
| Edit → verify → PR packaging | [references/workflow.md](references/workflow.md) |
| Failed command or permission recovery | [references/troubleshooting-workarounds.md](references/troubleshooting-workarounds.md) |

## Always

- Resolve repo from the request, then `github.repo`. Run `jr-rpc config get github.repo` standalone.
- Keep `--repo owner/repo` explicit on `gh`; use `git -C PATH` for local repos.
- Read applicable `AGENTS.md` before editing. Narrower repo/task instructions win.
- Preserve unrelated work. Never force-push, delete refs, or do destructive merges.
- Base conclusions on repository evidence. Do not claim a check ran unless it did.
- Push the branch before creating a Junior-owned PR. Runtime injects installation credentials; never ask for a user token for bot pushes.
- Tool-routing denials need the named tool. Only upstream denials justify permission remediation.
- Stop for ambiguous targets, missing access, destructive ops, or unresolved upstream permission failures.
- Unless the user opts out, finish completed edits with a pushed branch and PR (draft by default).
- Report to the user: repo, branch, PR URL/number, local check results, and anything not run.

Do not install or repair the GitHub plugin runtime from this skill. The plugin manifest owns that.
