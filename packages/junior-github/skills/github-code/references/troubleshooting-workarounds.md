# GitHub troubleshooting

| Problem                                                    | Action                                                                                    |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `gh` reports an unknown command                            | Report that the GitHub plugin is unavailable. Do not install it.                          |
| Clone rejects `--depth`                                    | Put clone flags after `--`: `gh repo clone owner/repo -- --depth=1`.                      |
| Repository is missing or wrong                             | Read `github.repo`, then pass `--repo owner/repo`.                                        |
| GraphQL cannot find the repository                         | Check `owner/repo` and the GitHub App installation.                                       |
| `junior-auth-required` with `user-write`                   | Follow the private OAuth prompt. Never ask for a pasted token.                            |
| `git push` returns 401 or 403                              | Check the remote and repository. Retry once, then report the installation access failure. |
| `permission_denied` has `source: "upstream"`               | GitHub rejected the request. Report the grant, account, or SSO details.                   |
| Other 403 response                                         | Read the error and use the tool it names.                                                 |
| `gh auth status` shows no token scopes                     | This is normal for GitHub App user tokens. Check App permissions instead.                 |
| `github_createPullRequest` returns 401 or 403              | Report the installation access failure. Do not use user OAuth.                            |
| PR creation returns 422 for `head`                         | Push the branch, then retry with explicit `head` and `base`.                              |
| PR create or update returns 422 for `base`                 | Read the default branch, then retry.                                                      |
| 403 names `github_updatePullRequest`                       | Use `github_updatePullRequest`.                                                           |
| PR review reports blocked GraphQL mutations                | Use `github_submitPullRequestReview`.                                                     |
| Review-thread resolution reports blocked GraphQL mutations | Use `github_resolvePullRequestReviewThread`. It works only on bot-authored PRs.           |
| Need to react to PR feedback (eyes/+1/-1)                   | Use `github_updatePullRequestFeedback`. Raw reaction REST calls are not supported.        |
| Blame or old history is missing                            | Deepen the needed refs. Unshallow only when required.                                     |
| Rebase has missing ancestry                                | Fetch `BASE:refs/remotes/origin/BASE`, deepen it, and use `origin/BASE`.                  |
| Dependencies are missing                                   | Run the frozen install. Do not change the lockfile.                                       |
| Frozen install fails                                       | Report the exact failure.                                                                 |
| Plugin setup fails                                         | Report the setup failure. Do not repair it from the skill.                                |

## Retry rules

- Retry a transport failure once after you check the repository.
- Do not repeat 401, 403, 404, or validation failures.
- A `user-read` or `user-write` failure needs private App OAuth.
- An `installation-*` failure needs an App permission or installation fix.
- Use structured `permission_denied` details when present.
