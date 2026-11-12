---
name: github-code
description: Work with GitHub repositories, source code, branches, commits, pull requests, reviews, diffs, CI, and repository credentials. Use for implementation, source investigation, clone/fetch/branch workflows, PR creation or updates, review feedback, GitHub Actions checks, and repository permission failures. Prefer this skill for repository tasks even when they concern a Sentry product.
---

# GitHub code

Use `git` and `gh` for repository work.

| Action                                 | Tool / command                                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Create PR                              | `github_createPullRequest` (not `gh pr create`)                                                               |
| Update PR title/description/base/state | `github_updatePullRequest`                                                                                    |
| Mark PR ready / draft                  | `github_updatePullRequest` with `draft: false` / `draft: true`                                                |
| Submit PR review                       | `github_submitPullRequestReview`                                                                              |
| Comment on PR / reply in thread        | `github_commentOnPullRequest` (`in_reply_to` for a thread reply)                                              |
| Resolve review thread                  | `github_resolvePullRequestReviewThread`                                                                       |
| Clone missing repo                     | `github_cloneRepository` (not `git clone` or `gh repo clone`); on Workspace match error use `switchWorkspace` |

## Open when needed

| Need                               | Read                                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| Commands and permissions           | [references/api-surface.md](references/api-surface.md)                                 |
| Edit, verify, and open a PR        | [references/workflow.md](references/workflow.md)                                       |
| Command, permission, or CI failure | [references/troubleshooting-workarounds.md](references/troubleshooting-workarounds.md) |

## Always

- Use the requested repo. Otherwise read `github.repo` with standalone `jr-rpc config get github.repo`.
- Pass `--repo owner/repo` to `gh`. Use `git -C PATH` for local repos.
- Read each applicable `AGENTS.md` before edits.
- Keep unrelated work. Never delete refs or make destructive merges.
- Force-push only with `--force-with-lease`, and only to branches Junior pushed or the requester named.
- Use repository evidence. Report only checks you ran.
- Push before `github_createPullRequest`. Never ask for a token for bot pushes.
- When an error names a tool, use it. Change permissions only when GitHub rejected the request.
- Stop for an unclear target, missing access, destructive work, or a GitHub permission failure.
- Code changes always end in a pushed branch and a PR. Do not ask whether to open one. Skip it only when the user opts out or asks for investigation only.
- Open the PR ready for review when the work is complete and the checks pass. Open a draft when work, checks, or decisions remain. A scope or follow-up question is not a reason to stop: open the PR, and name the question in the PR description context and the report.
- Link the PR. Mention checks only when they failed or were skipped.
- The runtime adds the requester `via` line. Do not write one.
- Credit other people, such as a reporter, by GitHub `@login` so GitHub notifies them. Get the login from `userLookup` (`linked_identities` with provider `github`, else a GitHub link in `profile_fields`). Pass the Slack user ID when known. With no login, write the name. Never guess a login. When you delegate the write, put the `@login` in the brief.

Do not install or repair the GitHub plugin from this skill.
