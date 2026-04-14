# GitHub CLI API Surface

All operations use `gh` CLI. Commands must be deterministic and non-interactive.

## Authentication

Issue credentials with `jr-rpc issue-credential <capability>` before executing commands. The runtime handles token injection transparently.
GitHub capabilities are repo-scoped. Pass `--target owner/repo` to `jr-rpc issue-credential` and `--repo owner/repo` to `gh` unless you intentionally rely on a verified `github.repo` default for the same repository.
Treat capability scope as a safety rail that reduces accidental writes and wrong-repo mutations, not as a perfect command-by-command security boundary.

## Capability to command mapping

| Capability                   | Commands                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| `github.contents.read`       | `gh repo clone`, `git fetch`                                                                |
| `github.contents.write`      | `git push`, `gh api` (create/update file contents), `gh pr merge`                           |
| `github.issues.read`         | `gh issue view`, `gh api /repos/.../comments`                                               |
| `github.issues.write`        | `gh issue create`, `gh issue edit`, `gh issue comment`, `gh issue close`, `gh issue reopen` |
| `github.pull-requests.read`  | `gh pr view`, `gh pr list`, `gh pr diff`, `gh pr checks`                                    |
| `github.pull-requests.write` | `gh pr create --head <branch>` after explicit push, `gh pr edit`, `gh pr close`             |

## Command matrix

| Operation                          | Command                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------- | ---------- |
| Clone repository (default shallow) | `gh repo clone owner/repo [DIRECTORY] -- --depth=1`                                                           |
| Deepen shallow clone               | `git -C DIRECTORY fetch --depth=N origin`                                                                     |
| Convert shallow clone to full      | `git -C DIRECTORY fetch --unshallow`                                                                          |
| Create issue                       | `gh issue create --repo owner/repo --title "..." --body-file PATH`                                            |
| Update issue fields                | `gh issue edit NUMBER --repo owner/repo [--title "..."] [--body-file PATH]`                                   |
| Close issue                        | `gh issue close NUMBER --repo owner/repo [--comment "..."]`                                                   |
| Reopen issue                       | `gh issue reopen NUMBER --repo owner/repo`                                                                    |
| Add labels                         | `gh issue edit NUMBER --repo owner/repo --add-label LABEL [--add-label LABEL2]`                               |
| Remove labels                      | `gh issue edit NUMBER --repo owner/repo --remove-label LABEL [--remove-label LABEL2]`                         |
| Add comment                        | `gh issue comment NUMBER --repo owner/repo --body-file PATH`                                                  |
| Read issue                         | `gh issue view NUMBER --repo owner/repo --json number,title,state,labels,assignees,author,url,body`           |
| Read comments                      | `gh api /repos/owner/repo/issues/NUMBER/comments --method GET --header "Accept: application/vnd.github+json"` |
| Push branch before PR creation     | `git -C DIRECTORY push -u origin BRANCH`                                                                      |
| Create pull request                | `gh pr create --repo owner/repo --head BRANCH --base BASE --title "..." --body-file PATH`                     |
| Update pull request                | `gh pr edit NUMBER --repo owner/repo [--title "..."] [--body-file PATH]`                                      |
| Close pull request                 | `gh pr close NUMBER --repo owner/repo`                                                                        |
| Merge pull request                 | `gh pr merge NUMBER --repo owner/repo [--merge                                                                | --squash | --rebase]` |

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
jr-rpc issue-credential github.contents.read --target owner/repo
jr-rpc issue-credential github.contents.write --target owner/repo
jr-rpc issue-credential github.issues.read --target owner/repo
jr-rpc issue-credential github.issues.write --target owner/repo
jr-rpc issue-credential github.pull-requests.read --target owner/repo
jr-rpc issue-credential github.pull-requests.write --target owner/repo
```

## Behavior notes

- Prefer `--json` output for machine-readable parsing where available.
- Use `gh api` for endpoints not fully covered by `gh issue` subcommands.
- Pass extra `git clone` flags after `--` (e.g. `gh repo clone owner/repo -- --depth=1`).
- For automation, always fully specify `gh issue create` with `--title` and `--body` or `--body-file`; never rely on interactive prompts.
- Before `gh pr create`, push the head branch explicitly with `github.contents.write`, then use `--head` so `gh` does not trigger hidden push/fork behavior.
- Keep `--repo owner/repo` explicit on authenticated GitHub commands when working across repositories.
- `gh pr edit` is not a single-permission command: title/body/base/reviewer changes fit `github.pull-requests.write`, label, assignee, and milestone changes fit `github.issues.write`, and project flags are outside the current GitHub App capability model.
- `gh pr close --comment` may need `github.issues.write`, and `gh pr close --delete-branch` needs `github.contents.write`.
- Return actionable errors for auth, permission, not-found, and validation failures.
