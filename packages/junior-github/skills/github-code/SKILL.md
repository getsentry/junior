---
name: github-code
description: Work with GitHub repositories, source code, branches, commits, pull requests, reviews, diffs, CI, and repository credentials. Use for implementation, source investigation, clone/fetch/branch workflows, PR creation or updates, review feedback, GitHub Actions checks, and repository permission failures. Prefer this skill for repository tasks even when they concern a Sentry product.
---

# GitHub Code Operations

Use `git` and `gh` for repository work.

| Action                          | Tool / command                                                           |
| ------------------------------- | ------------------------------------------------------------------------ |
| Create PR                       | `github_createPullRequest` (not `gh pr create`)                          |
| Update PR title/body/base/state | `github_updatePullRequest`                                               |
| Submit PR review                | `github_submitPullRequestReview`                                         |
| Resolve review thread           | `github_resolvePullRequestReviewThread`                                  |
| Clone missing repo              | `github_cloneRepository`; on Workspace match error use `switchWorkspace` |

## Open when needed

| Need                                  | Read                                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------------------- |
| Commands, permissions, allowlist      | [references/api-surface.md](references/api-surface.md)                                 |
| Edit → verify → PR packaging          | [references/workflow.md](references/workflow.md)                                       |
| Failed command or permission recovery | [references/troubleshooting-workarounds.md](references/troubleshooting-workarounds.md) |

## Always

- Use the requested repo. Otherwise read `github.repo` with standalone `jr-rpc config get github.repo`.
- Pass `--repo owner/repo` to `gh`. Use `git -C PATH` for local repos.
- Read each applicable `AGENTS.md` before edits.
- Keep unrelated work. Never force-push, delete refs, or make destructive merges.
- Use repository evidence. Report only checks you ran.
- Push before `github_createPullRequest`. Never ask for a token for bot pushes.
- When a denial names a tool, use it. Only upstream denials need permission repair.
- Stop for an unclear target, missing access, destructive work, or an upstream permission failure.
- Unless the user opts out, push completed work and open a draft PR.
- Report repo, branch, PR, checks, and skipped checks.

Do not install or repair the GitHub plugin runtime from this skill. The plugin manifest owns that.
