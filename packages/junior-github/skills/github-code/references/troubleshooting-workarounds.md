# GitHub CLI troubleshooting — code and pull requests

| Symptom                                             | Likely cause                          | Fix                                                                 |
| --------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------- |
| `unknown command` from `gh`                         | Runtime `gh` missing or too old       | Report GitHub plugin runtime dependency unavailable                 |
| `unknown flag: --depth` on clone                    | Clone flags before `--`               | `gh repo clone owner/repo -- --depth=1`                             |
| Missing `--repo`                                    | No explicit target                    | Resolve `github.repo`, pass `--repo owner/repo`                     |
| Wrong repo authenticated                            | Stale default                         | Pass `--repo owner/repo` or update `github.repo`                    |
| GraphQL: could not resolve repository               | Bad slug or no access                 | Validate `owner/repo` and App install                               |
| 401 Unauthorized                                    | Credential rejected                   | Confirm target; distinguish user OAuth vs installation setup        |
| `junior-auth-required` `user-write`                 | Missing/stale user OAuth              | Follow private OAuth prompt; never ask for pasted tokens            |
| `git push` 401/403                                  | Install scope, remote, or permissions | Verify remote/repo, retry once, then report install scope           |
| `permission_denied` `source: "upstream"`            | GitHub 403 after inject               | Not a local runtime block; use grant/account/SSO fields             |
| 403 without upstream `permission_denied`            | Local policy denial                   | Read body; follow required-tool guidance                            |
| `Token scopes: none` on `gh auth status`            | Normal for App user tokens            | Use App permissions / accepted-permissions headers                  |
| `github_createPullRequest` 401/403                  | Install/repo lacks write              | Report install scope; do not fall back to user OAuth                |
| Create PR 422 on `head`                             | Branch not pushed                     | Push branch; retry with explicit head/base                          |
| Create/update PR 422 on `base`                      | Base missing                          | Resolve default branch; retry                                       |
| 403 names `github_updatePullRequest`                | Raw PR PATCH blocked                  | Use `github_updatePullRequest`                                      |
| GraphQL mutations not enabled during PR review      | `gh pr review` uses GraphQL           | Use `github_submitPullRequestReview`                                |
| GraphQL mutations not enabled during thread resolve | Raw resolve blocked                   | Use `github_resolvePullRequestReviewThread` (bot-authored PRs only) |
| Missing blame/old history                           | Shallow clone                         | Deepen needed refs; `--unshallow` only if required                  |
| Odd ancestry / rebase fails                         | Base ref missing locally              | Fetch `BASE:refs/remotes/origin/BASE`, deepen, use `origin/BASE`    |
| Missing deps in tests                               | Not installed                         | Frozen/immutable install for the lockfile; do not rewrite lockfile  |
| Frozen install fails                                | Drift or registry                     | Report exact failure                                                |
| `dnf install gh failed`                             | Plugin bootstrap                      | Report runtime bootstrap failure; do not repair from skill          |

## Retry rules

- Retry once for transient transport after verifying repo context.
- Do not loop on repeated 401/403/404 validation errors.
- `user-read`/`user-write` gaps → private App OAuth. `installation-*` failures → App permission/install/host setup only.
- Prefer `permission_denied` structured fields over guessing.
- Persistent permission problems: report remediation and stop.
