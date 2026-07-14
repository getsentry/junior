# GitHub API Surface — code & pull requests

PR creation uses Junior's `github_createPullRequest` tool. Supported mutations use allowlisted REST endpoints through `gh api`; generic GraphQL-backed `gh pr` mutations are not supported.

## Repo scoping

When the user omits `owner/repo`, resolve `github.repo` first with `jr-rpc config get github.repo`, then pass the resolved repo explicitly on the actual `gh` or `git` command.
Run `jr-rpc config get github.repo` as a standalone bash command. Never chain it with `cd`, `&&`, pipes, or a provider command.
Treat explicit repo flags as command-targeting safety rails, not as a credential-scoping mechanism.

## GitHub App permission guidance

| Permission capability        | Commands                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------ |
| `github.actions.read`        | `gh run list`, `gh run view`, `gh run watch`, `gh workflow list`, `gh workflow view` |
| `github.actions.write`       | `gh workflow run` only                                                               |
| `github.contents.read`       | `gh repo clone`, `git fetch`                                                         |
| `github.contents.write`      | Git smart-HTTP `git push` only                                                       |
| `github.workflows.write`     | Workflow-file changes carried by Git smart-HTTP push                                 |
| `github.pull-requests.read`  | `gh pr view`, `gh pr list`, `gh pr diff`, `gh pr checks`                             |
| `github.pull-requests.write` | Typed PR creation and allowlisted REST PR lifecycle endpoints                        |

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
| Dispatch workflow                  | `gh workflow run WORKFLOW --repo owner/repo --ref REF [-f key=value]`                                                    |
| Create pull request (draft)        | `github_createPullRequest({ repo: "owner/repo", head: "BRANCH", base: "BASE", title: "...", body: "...", draft: true })` |
| Update pull request                | `gh api repos/owner/repo/pulls/NUMBER --method PATCH --input payload.json`                                               |
| Mark ready for review              | `gh api repos/owner/repo/pulls/NUMBER/ready_for_review --method POST`                                                    |
| Request reviewers                  | `gh api repos/owner/repo/pulls/NUMBER/requested_reviewers --method POST --input reviewers.json`                          |
| Remove requested reviewers         | `gh api repos/owner/repo/pulls/NUMBER/requested_reviewers --method DELETE --input reviewers.json`                        |
| Close pull request                 | `gh api repos/owner/repo/pulls/NUMBER --method PATCH -f state=closed`                                                    |
| Submit human review                | `gh api repos/owner/repo/pulls/NUMBER/reviews --method POST --input review.json`                                         |
| View pull request                  | `gh pr view NUMBER --repo owner/repo [--json ...]`                                                                       |
| List pull requests                 | `gh pr list --repo owner/repo [--state open \| closed \| merged]`                                                        |
| Diff pull request                  | `gh pr diff NUMBER --repo owner/repo`                                                                                    |
| Check pull request status          | `gh pr checks NUMBER --repo owner/repo`                                                                                  |
| View PR review comments            | `gh api repos/{owner}/{repo}/pulls/{number}/comments`                                                                    |
| View PR reviews                    | `gh api repos/{owner}/{repo}/pulls/{number}/reviews`                                                                     |
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
- A local `git commit` does not call GitHub. Pushing that commit uses Junior's repository-scoped installation credential and requires `github.contents.write` on the target repo.
- If the commit changes workflow files under `.github/workflows`, the App installation needs Workflows write in addition to Contents write.
- Before `github_createPullRequest`, push the head branch explicitly and resolve the target repo's default branch for `base`. That push requires GitHub write access to the remote.
- Merge, fork creation, workflow reruns or cancellations, REST contents/Git database writes, and repository administration are outside the current write allowlist.
- If the explicit `git push` fails with 401/403 or another access/permission error, verify the repo context and retry once. If it still fails, load troubleshooting guidance and report the exact command failure.
- PR comments, labels, and assignees use GitHub's issue endpoints; use the `github-issues` REST guidance for those operations. All allowlisted bot writes share the same repository-scoped `installation-write` credential.
- Return actionable errors for access, permission, not-found, and validation failures.
