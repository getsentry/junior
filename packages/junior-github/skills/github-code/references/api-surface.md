# GitHub API surface — code and pull requests

PR create/update and review-thread resolve use the tools named in `SKILL.md`. Other supported mutations use allowlisted REST through `gh api`. Generic GraphQL-backed `gh pr` mutations are not supported.

## Repo targeting

When the user omits `owner/repo`, resolve with standalone `jr-rpc config get github.repo`, then pass `--repo owner/repo` on the next `gh`/`git` command. Explicit repo flags target the command; they are not a credential scope.

## Permissions

| Capability | Commands |
| --- | --- |
| `github.actions.read` | `gh run list`, `gh run view`, `gh run watch`, `gh workflow list`, `gh workflow view` |
| `github.actions.write` | `gh workflow run`, `gh run rerun`, `gh run cancel` |
| `github.contents.read` | `gh repo clone`, `git fetch` |
| `github.contents.write` | Git smart-HTTP `git push` only |
| `github.workflows.write` | Workflow-file changes on push |
| `github.pull-requests.read` | `gh pr view`, `gh pr list`, `gh pr diff`, `gh pr checks` |
| `github.pull-requests.write` | Typed PR create and allowlisted REST PR lifecycle |

## Commands

| Operation | Command |
| --- | --- |
| Clone (default shallow) | `gh repo clone owner/repo [DIR] -- --depth=1` |
| Fetch bounded base | `git -C DIR fetch --depth=N origin BASE:refs/remotes/origin/BASE` |
| Deepen base | `git -C DIR fetch --deepen=N origin BASE:refs/remotes/origin/BASE` |
| Unshallow | `git -C DIR fetch --unshallow origin` |
| Shallow check | `git -C DIR rev-parse --is-shallow-repository` |
| Branch / status | `git -C DIR branch --show-current` / `git -C DIR status --short --branch` |
| Log / diff vs base | `git -C DIR log origin/BASE..HEAD --oneline` / `git -C DIR diff origin/BASE...HEAD` |
| Default branch | `gh repo view owner/repo --json defaultBranchRef --jq .defaultBranchRef.name` |
| Create branch | `git -C DIR checkout -b BRANCH` |
| Commit | `git -C DIR add -A && git -C DIR commit -m "message"` |
| Push | `git -C DIR push -u origin BRANCH` |
| Workflow dispatch | `gh workflow run WORKFLOW --repo owner/repo --ref REF [-f key=value]` |
| Rerun / cancel | `gh run rerun RUN_ID -R owner/repo [--failed]` / `gh run cancel RUN_ID -R owner/repo` |
| Ready for review | `gh api repos/owner/repo/pulls/NUMBER/ready_for_review --method POST` |
| Request reviewers | `gh api repos/owner/repo/pulls/NUMBER/requested_reviewers --method POST --input reviewers.json` |
| Submit review | `gh api repos/owner/repo/pulls/NUMBER/reviews --method POST --input review.json` |
| Inline review comment | `gh api repos/owner/repo/pulls/NUMBER/comments --method POST --input comment.json` |
| View PR / checks | `gh pr view NUMBER --repo owner/repo` / `gh pr checks NUMBER --repo owner/repo` |
| Diff PR | `gh pr diff NUMBER --repo owner/repo` |
| List runs | `gh run list -R owner/repo --workflow WORKFLOW` |
| View / watch run | `gh run view RUN_ID -R owner/repo` / `gh run watch RUN_ID -R owner/repo --exit-status` |

## Notes

- Prefer `--json` where available. Pass clone flags after `--`.
- Local commit does not call GitHub. Push uses installation credentials (`contents.write`; workflow files also need `workflows.write`).
- Before history-dependent git work, deepen shallow clones; never force-push around missing ancestry.
- Push head and resolve default `base` before `github_createPullRequest`.
- Denied: merge, forks, REST contents/Git database writes, repo admin, raw PR PATCH, raw GraphQL mutations.
- Reviews and inline comments post as the App bot via `installation-write`.
- PR comments/labels/assignees use issue endpoints; load `github-issues` for those.
- Embed local images with `publishImage` first (public URL). Do not use private Slack file links.
