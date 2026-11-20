# GitHub troubleshooting

| Problem                                                    | Action                                                                                    |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `gh` reports an unknown command                            | Report that the GitHub plugin is unavailable. Do not install it.                          |
| Repository is missing or wrong                             | Read `github.repo`, then pass `--repo owner/repo`.                                        |
| GraphQL cannot find the repository                         | Check `owner/repo` and the GitHub App installation.                                       |
| `junior-auth-required` with `user-write`                   | Follow the private OAuth prompt. Never ask for a pasted token.                            |
| `git push` returns 401 or 403                              | Check the remote and repository. Retry once, then report the installation access failure. |
| `permission_denied` has `source: "upstream"`               | Read GitHub's error. Report an access problem only if it says access denied or SSO.       |
| `permission_denied` has `source: "policy"`                 | The runtime refused it. Follow its message. Push a new branch and open a PR.              |
| Other 403 response                                         | Read the error and use the tool it names.                                                 |
| `gh auth status` shows no token scopes                     | This is normal for GitHub App user tokens. Check App permissions instead.                 |
| `github_createPullRequest` returns 401 or 403              | Report the installation access failure. Do not use user OAuth.                            |
| PR creation returns 422 for `head`                         | Push the branch, then retry with explicit `head` and `base`.                              |
| PR create or update returns 422 for `base`                 | Read the default branch, then retry.                                                      |
| 403 names `github_updatePullRequest`                       | Use `github_updatePullRequest`.                                                           |
| PR review reports blocked GraphQL mutations                | Use `github_submitPullRequestReview`.                                                     |
| Review-thread resolution reports blocked GraphQL mutations | Use `github_resolvePullRequestReviewThread`. It works only on bot-authored PRs.           |
| Blame or old history is missing                            | Deepen the needed refs. Unshallow only when required.                                     |
| Rebase has missing ancestry                                | Fetch `BASE:refs/remotes/origin/BASE`, deepen it, and use `origin/BASE`.                  |
| Dependencies are missing                                   | Run the frozen install. Do not change the lockfile.                                       |
| Frozen install fails                                       | Report the exact failure.                                                                 |
| Plugin setup fails                                         | Report the setup failure. Do not repair it from the skill.                                |
| GitHub returns 5xx, times out, or drops the connection     | Check GitHub status.                                                                      |
| Checks stay queued, stall, or fail with no cause in logs   | Check GitHub status.                                                                      |

## Retry rules

- Retry a transport failure once after you check the repository. If it fails again, check GitHub status.
- Do not repeat 401, 403, 404, or validation failures.
- A `user-read` or `user-write` failure needs private App OAuth.
- An `installation-*` access denial needs an App permission or installation fix.
- Use structured `permission_denied` details when present.

## GitHub status

Call `github_getStatus`. It lists GitHub incidents that are open or were resolved in the last 24 hours. All callers share one cached read of githubstatus.com. Do not read the status page another way.

A `pull_request.checks.failed` event already lists incidents that are open or ended in the last hour. Use that list before you call the tool.

- An incident matches when its time covers the failure and its components cover the failing operation: `Git Operations` for clone, fetch, and push; `API Requests` for `gh` and GitHub tools; `Actions` for workflow runs; `Pull Requests`, `Issues`, or `Webhooks` for those features and missing events.
- Match: say the failure is likely from that incident, and link it. Do not keep retrying. Do not change code, permissions, or workflows to work around it.
- No match: say GitHub status shows no related incident, and continue from the error. Do not blame an outage.
- If `github_getStatus` fails, say that GitHub status is unknown. Do not guess.
- A 401, 403, 404, or 422 usually gives its own cause. Check status for one only when that cause does not fit, such as a 404 for a repository you just read.
