# GitHub API Surface — code & pull requests

PR creation uses Junior's `github_createPullRequest` tool. PR title, body, base, and open/closed state updates use `github_updatePullRequest` so Junior keeps requester attribution and the conversation footer. Review-thread resolve uses `github_resolvePullRequestReviewThread` because GitHub exposes only the GraphQL `resolveReviewThread` mutation (no REST endpoint and no first-class `gh pr` subcommand). Other supported mutations use allowlisted REST endpoints through `gh api`; generic GraphQL-backed `gh pr` mutations are not supported.

## Repo scoping

When the user omits `owner/repo`, resolve `github.repo` first with `jr-rpc config get github.repo`, then pass the resolved repo explicitly on the actual `gh` or `git` command.
Run `jr-rpc config get github.repo` as a standalone bash command. Never chain it with `cd`, `&&`, pipes, or a provider command.
Treat explicit repo flags as command-targeting safety rails, not as a credential-scoping mechanism.

## GitHub App permission guidance

| Permission capability        | Commands                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------ |
| `github.actions.read`        | `gh run list`, `gh run view`, `gh run watch`, `gh workflow list`, `gh workflow view` |
| `github.actions.write`       | `gh workflow run`, `gh run rerun`, `gh run cancel`                                   |
| `github.contents.read`       | `gh repo clone`, `git fetch`                                                         |
| `github.contents.write`      | Git smart-HTTP `git push` only                                                       |
| `github.workflows.write`     | Workflow-file changes carried by Git smart-HTTP push                                 |
| `github.pull-requests.read`  | `gh pr view`, `gh pr list`, `gh pr diff`, `gh pr checks`                             |
| `github.pull-requests.write` | Typed PR creation and allowlisted REST PR lifecycle endpoints                        |

## Command matrix

| Operation                          | Command                                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Clone repository (default shallow) | `gh repo clone owner/repo [DIRECTORY] -- --depth=1`                                                                      |
| Fetch bounded base history         | `git -C DIRECTORY fetch --depth=N origin BASE:refs/remotes/origin/BASE`                                                  |
| Deepen base history                | `git -C DIRECTORY fetch --deepen=N origin BASE:refs/remotes/origin/BASE`                                                 |
| Convert shallow clone to full      | `git -C DIRECTORY fetch --unshallow origin`                                                                              |
| Check shallow state                | `git -C DIRECTORY rev-parse --is-shallow-repository`                                                                     |
| Check branch                       | `git -C DIRECTORY branch --show-current`                                                                                 |
| Check worktree state               | `git -C DIRECTORY status --short --branch`                                                                               |
| View commit log against base       | `git -C DIRECTORY log origin/BASE..HEAD --oneline`                                                                       |
| Diff against base                  | `git -C DIRECTORY diff origin/BASE...HEAD`                                                                               |
| Resolve default branch             | `gh repo view owner/repo --json defaultBranchRef --jq .defaultBranchRef.name`                                            |
| Create branch                      | `git -C DIRECTORY checkout -b BRANCH`                                                                                    |
| Stage and commit                   | `git -C DIRECTORY add -A && git -C DIRECTORY commit -m "message"`                                                        |
| Push branch before PR creation     | `git -C DIRECTORY push -u origin BRANCH`                                                                                 |
| Dispatch workflow                  | `gh workflow run WORKFLOW --repo owner/repo --ref REF [-f key=value]`                                                    |
| Rerun workflow run                 | `gh run rerun RUN_ID -R owner/repo [--failed]`                                                                          |
| Rerun workflow job                 | `gh run rerun --job JOB_ID -R owner/repo`                                                                               |
| Cancel workflow run                | `gh run cancel RUN_ID -R owner/repo`                                                                                     |
| Create pull request (draft)        | `github_createPullRequest({ repo: "owner/repo", head: "BRANCH", base: "BASE", title: "...", body: "...", draft: true })` |
| Update pull request                | `github_updatePullRequest({ repo: "owner/repo", number: NUMBER, title?: "...", body?: "...", base?: "BASE", state?: "open" \| "closed" })` |
| Mark ready for review              | `gh api repos/owner/repo/pulls/NUMBER/ready_for_review --method POST`                                                    |
| Request reviewers                  | `gh api repos/owner/repo/pulls/NUMBER/requested_reviewers --method POST --input reviewers.json`                          |
| Remove requested reviewers         | `gh api repos/owner/repo/pulls/NUMBER/requested_reviewers --method DELETE --input reviewers.json`                        |
| Close pull request                 | `github_updatePullRequest({ repo: "owner/repo", number: NUMBER, state: "closed" })`                                      |
| Submit pull request review         | `gh api repos/owner/repo/pulls/NUMBER/reviews --method POST --input review.json`                                         |
| Post inline review comment         | `gh api repos/owner/repo/pulls/NUMBER/comments --method POST --input comment.json`                                       |
| Reply to inline review comment     | `gh api repos/owner/repo/pulls/NUMBER/comments/COMMENT_ID/replies --method POST --input reply.json`                      |
| Resolve review thread              | `github_resolvePullRequestReviewThread({ repo: "owner/repo", threadId: "PRRT_..." })` (GraphQL `resolveReviewThread` substitute; Junior-authored PRs only) |
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
- A local `git commit` does not call GitHub. Pushing that commit uses Junior's installation credential and requires `github.contents.write` on the target repo.
- If the commit changes workflow files under `.github/workflows`, the App installation needs Workflows write in addition to Contents write.
- Before rebasing, merge-base analysis, blame/history inspection, or a base comparison, check whether the repository is shallow. Fetch a bounded depth of the base into `refs/remotes/origin/BASE`, deepen incrementally until the needed ancestry is present, and compare against `origin/BASE`; use `--unshallow` only when bounded deepening is insufficient. Never force-push to work around missing ancestry.
- Before `github_createPullRequest`, push the head branch explicitly and resolve the target repo's default branch for `base`. That push requires GitHub write access to the remote.
- Use `github_updatePullRequest` for title, body, base, or open/closed state changes. Do not raw-`PATCH` `/repos/.../pulls/NUMBER`; that path is denied so Junior can keep the conversation footer.
- Merge, fork creation, REST contents/Git database writes, and repository administration are outside the current write allowlist.
- Pull request reviews and inline review comments use the same `installation-write` credential as other bot-owned PR writes, so they post as Junior even on headless turns. Merge remains denied.
- Resolve review threads with `github_resolvePullRequestReviewThread`. That tool is the Junior equivalent of `gh api graphql` `resolveReviewThread`; raw GraphQL mutations stay denied, and the tool only succeeds on Junior-authored PRs.
- If the explicit `git push` fails with 401/403 or another access/permission error, verify the repo context and retry once. If it still fails, load troubleshooting guidance and report the exact command failure.
- PR comments, labels, and assignees use GitHub's issue endpoints; use the `github-issues` REST guidance for those operations. All allowlisted bot writes share the same `installation-write` credential.
- To embed a local image in a GitHub issue, pull request, review, or comment, call `publishImage` first. That tool returns a durable public URL. The published image is public to anyone on the internet who has the URL. Embed the URL with normal GitHub Markdown. Do not use private Slack file links or conversation attachment URLs.
- Return actionable errors for access, permission, not-found, and validation failures.
