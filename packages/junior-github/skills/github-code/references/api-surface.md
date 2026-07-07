# GitHub API Surface — code & pull requests

PR creation uses Junior's `github_createPullRequest` tool. Other operations use `gh` CLI and must be deterministic and non-interactive.

## Repo scoping

When the user omits `owner/repo`, resolve `github.repo` first with `jr-rpc config get github.repo`, then pass the resolved repo explicitly on the actual `gh` or `git` command.
Run `jr-rpc config get github.repo` as a standalone bash command. Never chain it with `cd`, `&&`, pipes, or a provider command.
Treat explicit repo flags as command-targeting safety rails, not as a credential-scoping mechanism.

## GitHub App permission guidance

| Permission capability                                  | Commands                                                                             |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `github.actions.read`                                  | `gh run list`, `gh run view`, `gh run watch`, `gh workflow list`, `gh workflow view` |
| `github.actions.write`                                 | `gh workflow run`, `gh run rerun`, `gh run cancel`                                   |
| `github.contents.read`                                 | `gh repo clone`, `git fetch`                                                         |
| `github.contents.write`                                | `git push`, REST Git database writes, `gh api` create/update contents, `gh pr merge` |
| `github.workflows.write`                               | Workflow-file changes under `.github/workflows`                                      |
| `github.pull-requests.read`                            | `gh pr view`, `gh pr list`, `gh pr diff`, `gh pr checks`                             |
| `github.pull-requests.write`                           | `github_createPullRequest` after explicit push, `gh pr edit`, `gh pr close`          |
| `github.administration.write` + `github.contents.read` | `gh repo fork`; avoid for routine PR creation                                        |

## Command matrix

| Operation                          | Command                                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Clone repository (default shallow) | `gh repo clone owner/repo [DIRECTORY] -- --depth=1`                                                                      |
| Deepen shallow clone               | `git -C DIRECTORY fetch --depth=N origin`                                                                                |
| Convert shallow clone to full      | `git -C DIRECTORY fetch --unshallow`                                                                                     |
| Check branch                       | `git -C DIRECTORY branch --show-current`                                                                                 |
| Check worktree state               | `git -C DIRECTORY status --short --branch`                                                                               |
| View commit log against base       | `git -C DIRECTORY log BASE..HEAD --oneline`                                                                              |
| Diff against base                  | `git -C DIRECTORY diff BASE...HEAD`                                                                                      |
| Resolve default branch             | `gh repo view owner/repo --json defaultBranchRef --jq .defaultBranchRef.name`                                            |
| Create branch                      | `git -C DIRECTORY checkout -b BRANCH`                                                                                    |
| Stage and commit                   | `git -C DIRECTORY add -A && git -C DIRECTORY commit -m "message"`                                                        |
| Push branch before PR creation     | `git -C DIRECTORY push -u origin BRANCH`                                                                                 |
| Create pull request (draft)        | `github_createPullRequest({ repo: "owner/repo", head: "BRANCH", base: "BASE", title: "...", body: "...", draft: true })` |
| Update pull request                | `gh pr edit NUMBER --repo owner/repo [--title "..."] [--body-file PATH]`                                                 |
| Close pull request                 | `gh pr close NUMBER --repo owner/repo`                                                                                   |
| Merge pull request                 | `gh pr merge NUMBER --repo owner/repo [--merge \| --squash \| --rebase]`                                                 |
| View pull request                  | `gh pr view NUMBER --repo owner/repo [--json ...]`                                                                       |
| List pull requests                 | `gh pr list --repo owner/repo [--state open \| closed \| merged]`                                                        |
| Diff pull request                  | `gh pr diff NUMBER --repo owner/repo`                                                                                    |
| Check pull request status          | `gh pr checks NUMBER --repo owner/repo`                                                                                  |
| View PR review comments            | `gh api repos/{owner}/{repo}/pulls/{number}/comments`                                                                    |
| View PR reviews                    | `gh api repos/{owner}/{repo}/pulls/{number}/reviews`                                                                     |
| Dispatch workflow                  | `gh workflow run WORKFLOW -R owner/repo --ref REF [-f key=value ...]`                                                    |
| List workflow runs                 | `gh run list -R owner/repo --workflow WORKFLOW [--limit N] [--json ...]`                                                 |
| View workflow run                  | `gh run view RUN_ID -R owner/repo [--json ...] [--log-failed]`                                                           |
| Watch workflow run                 | `gh run watch RUN_ID -R owner/repo --exit-status`                                                                        |

## Config helpers

```bash
jr-rpc config get github.repo
jr-rpc config set github.repo owner/repo
```

## Behavior notes

- Prefer `--json` output for machine-readable parsing where available.
- Pass extra `git clone` flags after `--` (e.g. `gh repo clone owner/repo -- --depth=1`).
- A local `git commit` does not call GitHub. Pushing that commit does: `git push` requires `github.contents.write` on the target repo and actor write access.
- REST Git commit construction also requires `github.contents.write`: `POST /git/blobs`, `POST /git/trees`, `POST /git/commits`, `POST /git/refs`, and `PATCH /git/refs/{ref}`.
- If the commit changes workflow files under `.github/workflows`, expect `github.workflows.write` in addition to contents write.
- Before `github_createPullRequest`, push the head branch explicitly and resolve the target repo's default branch for `base`. That push requires GitHub write access to the remote.
- Do not use fork creation as the normal PR path. GitHub requires Administration write plus Contents read for `POST /repos/{owner}/{repo}/forks`, and the app must be installed on both source and destination accounts.
- If the explicit `git push` fails with 401/403 or another access/permission error, verify the repo context and retry once. If it still fails, load troubleshooting guidance and report the exact command failure.
- `gh pr edit` is not a single-permission command: title/body/base/reviewer changes need pull request write permission; label, assignee, and milestone changes need issue write permission (use the `github-issues` skill); project flags are outside the current GitHub App permission guidance.
- `gh pr close --comment` may need `github.issues.write` (use `github-issues`); `gh pr close --delete-branch` needs `github.contents.write`.
- Return actionable errors for access, permission, not-found, and validation failures.
