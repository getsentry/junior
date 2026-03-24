# GitHub CLI API Surface

All operations use `gh` CLI. Commands must be deterministic and non-interactive.

## Authentication

- Preferred: sandbox network policy injects Authorization headers for `api.github.com`.
- Optional local fallback: `GITHUB_TOKEN` (short-lived GitHub App installation token).
- `GITHUB_TOKEN` holds a placeholder; rely on header transforms for auth. The sandbox injects headers for `api.github.com` and `github.com` (for git-transport capabilities).

## Capability to command mapping

| Capability                   | Commands                                                                |
| ---------------------------- | ----------------------------------------------------------------------- |
| `github.contents.read`       | `gh repo clone`, `git fetch`                                            |
| `github.contents.write`      | `git push`, `gh api` (create/update file contents)                      |
| `github.issues.read`         | `gh issue view`, `gh api /repos/.../comments`                           |
| `github.issues.write`        | `gh issue create`, `gh issue edit`, `gh issue close`, `gh issue reopen` |
| `github.issues.comment`      | `gh issue comment`                                                      |
| `github.labels.write`        | `gh issue edit --add-label/--remove-label`                              |
| `github.pull-requests.read`  | `gh pr view`, `gh pr list`, `gh pr diff`, `gh pr checks`                |
| `github.pull-requests.write` | `gh pr create`, `gh pr edit`, `gh pr merge`, `gh pr close`              |

## Command matrix

| Operation                          | Command                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Clone repository (default shallow) | `gh repo clone owner/repo [DIRECTORY] -- --depth=1`                                                           |
| Deepen shallow clone               | `git -C DIRECTORY fetch --depth=N origin`                                                                     |
| Convert shallow clone to full      | `git -C DIRECTORY fetch --unshallow`                                                                          |
| Create issue                       | `gh issue create --repo owner/repo --title "..." [--body-file PATH]`                                          |
| Update issue fields                | `gh issue edit NUMBER --repo owner/repo [--title "..."] [--body-file PATH]`                                   |
| Close issue                        | `gh issue close NUMBER --repo owner/repo [--comment "..."]`                                                   |
| Reopen issue                       | `gh issue reopen NUMBER --repo owner/repo`                                                                    |
| Add labels                         | `gh issue edit NUMBER --repo owner/repo --add-label LABEL [--add-label LABEL2]`                               |
| Remove labels                      | `gh issue edit NUMBER --repo owner/repo --remove-label LABEL [--remove-label LABEL2]`                         |
| Add comment                        | `gh issue comment NUMBER --repo owner/repo --body-file PATH`                                                  |
| Read issue                         | `gh issue view NUMBER --repo owner/repo --json number,title,state,labels,assignees,author,url,body`           |
| Read comments                      | `gh api /repos/owner/repo/issues/NUMBER/comments --method GET --header "Accept: application/vnd.github+json"` |

## Credential and config helpers

Resolve repo default:

```bash
jr-rpc config get github.repo
```

Set repo default:

```bash
jr-rpc config set github.repo owner/repo
```

Issue scoped credentials:

```bash
jr-rpc issue-credential github.contents.read --repo owner/repo
jr-rpc issue-credential github.contents.write --repo owner/repo
jr-rpc issue-credential github.issues.read
jr-rpc issue-credential github.issues.write
jr-rpc issue-credential github.issues.comment
jr-rpc issue-credential github.labels.write
jr-rpc issue-credential github.pull-requests.read
jr-rpc issue-credential github.pull-requests.write
```

## Behavior notes

- Prefer `--json` output for machine-readable parsing where available.
- Use `gh api` for endpoints not fully covered by `gh issue` subcommands.
- Pass extra `git clone` flags after `--` (e.g. `gh repo clone owner/repo -- --depth=1`).
- Return actionable errors for auth, permission, not-found, and validation failures.
