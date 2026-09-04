# GitHub commands and permissions

Use the tools in `SKILL.md` to create or update a PR, submit a review, or resolve a review thread. Use supported REST endpoints for other writes. Do not use GraphQL mutations.

## Repo targeting

If the user omits `owner/repo`, run `jr-rpc config get github.repo`. Then pass `--repo owner/repo` to `gh`.

## Permissions

| Capability                   | Commands                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------ |
| `github.actions.read`        | `gh run list`, `gh run view`, `gh run watch`, `gh workflow list`, `gh workflow view` |
| `github.actions.write`       | `gh workflow run`, `gh run rerun`, `gh run cancel`                                   |
| `github.contents.read`       | `gh repo clone`, `git fetch`                                                         |
| `github.contents.write`      | Git smart-HTTP `git push` only                                                       |
| `github.workflows.write`     | Workflow-file changes on push                                                        |
| `github.pull-requests.read`  | `gh pr view`, `gh pr list`, `gh pr diff`, `gh pr checks`                             |
| `github.pull-requests.write` | GitHub tools and supported REST writes                                               |

## Commands

| Operation               | Command                                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| Clone (default shallow) | `gh repo clone owner/repo [DIR] -- --depth=1`                                                   |
| Fetch bounded base      | `git -C DIR fetch --depth=N origin BASE:refs/remotes/origin/BASE`                               |
| Deepen base             | `git -C DIR fetch --deepen=N origin BASE:refs/remotes/origin/BASE`                              |
| Unshallow               | `git -C DIR fetch --unshallow origin`                                                           |
| Shallow check           | `git -C DIR rev-parse --is-shallow-repository`                                                  |
| Branch / status         | `git -C DIR branch --show-current` / `git -C DIR status --short --branch`                       |
| Log / diff vs base      | `git -C DIR log origin/BASE..HEAD --oneline` / `git -C DIR diff origin/BASE...HEAD`             |
| Default branch          | `gh repo view owner/repo --json defaultBranchRef --jq .defaultBranchRef.name`                   |
| Create branch           | `git -C DIR checkout -b BRANCH`                                                                 |
| Commit                  | `git -C DIR add -A && git -C DIR commit -m "message"`                                           |
| Push                    | `git -C DIR push -u origin BRANCH`                                                              |
| Workflow dispatch       | `gh workflow run WORKFLOW --repo owner/repo --ref REF [-f key=value]`                           |
| Rerun / cancel          | `gh run rerun RUN_ID -R owner/repo [--failed]` / `gh run cancel RUN_ID -R owner/repo`           |
| Ready for review        | `gh api repos/owner/repo/pulls/NUMBER/ready_for_review --method POST`                           |
| Request reviewers       | `gh api repos/owner/repo/pulls/NUMBER/requested_reviewers --method POST --input reviewers.json` |
| Submit review           | `github_submitPullRequestReview`                                                                |
| Set feedback status     | `github_updatePullRequestFeedback`                                                              |
| Resolve review thread   | `github_resolvePullRequestReviewThread`                                                         |
| Inline review comment   | `gh api repos/owner/repo/pulls/NUMBER/comments --method POST --input comment.json`              |
| View PR / checks        | `gh pr view NUMBER --repo owner/repo` / `gh pr checks NUMBER --repo owner/repo`                 |
| Diff PR                 | `gh pr diff NUMBER --repo owner/repo`                                                           |
| List runs               | `gh run list -R owner/repo --workflow WORKFLOW`                                                 |
| View / watch run        | `gh run view RUN_ID -R owner/repo` / `gh run watch RUN_ID -R owner/repo --exit-status`          |

## Notes

- Prefer `--json` where available. Pass clone flags after `--`.
- A local commit does not call GitHub. A push uses installation credentials. Workflow changes also need `workflows.write`.
- Deepen a shallow clone before work that needs old history. Do not force-push to work around missing history.
- Push `head` and read the default `base` before `github_createPullRequest`.
- Junior does not support merges, forks, repository administration, REST content or Git database writes, direct PR update or review writes, or GraphQL mutations.
- Reviews and inline comments use the App bot.
- Mark feedback with `github_updatePullRequestFeedback`: `reviewing` while working on an item, then `addressed` or `declined` when done. It replaces only Junior's own prior status reaction on that comment. For inline review feedback, also call `github_resolvePullRequestReviewThread` to resolve the thread.
- PR comments/labels/assignees use issue endpoints; load `github-issues` for those.
- Embed local images with `publishImage` first (public URL). Do not use private Slack file links.
