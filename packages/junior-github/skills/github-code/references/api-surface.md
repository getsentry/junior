# GitHub CLI API Surface — code & pull requests

All operations use `gh` CLI. Commands must be deterministic and non-interactive.

## Repo scoping

When the user omits `owner/repo`, resolve `github.repo` first with `jr-rpc config get github.repo`, then pass the resolved repo explicitly on the actual `gh` or `git` command.
Run `jr-rpc config get github.repo` as a standalone bash command. Never chain it with `cd`, `&&`, pipes, or a provider command.
Treat explicit repo flags as command-targeting safety rails, not as a credential-scoping mechanism.

## Capability to command mapping

| Capability                   | Commands                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------- |
| `github.contents.read`       | `gh repo clone`, `git fetch`                                                    |
| `github.contents.write`      | `git push`, `gh api` (create/update file contents), `gh pr merge`               |
| `github.pull-requests.read`  | `gh pr view`, `gh pr list`, `gh pr diff`, `gh pr checks`                        |
| `github.pull-requests.write` | `gh pr create --head <branch>` after explicit push, `gh pr edit`, `gh pr close` |

## Command matrix

| Operation                          | Command                                                                                   |
| ---------------------------------- | ----------------------------------------------------------------------------------------- | -------- | ---------- |
| Clone repository (default shallow) | `gh repo clone owner/repo [DIRECTORY] -- --depth=1`                                       |
| Deepen shallow clone               | `git -C DIRECTORY fetch --depth=N origin`                                                 |
| Convert shallow clone to full      | `git -C DIRECTORY fetch --unshallow`                                                      |
| Push branch before PR creation     | `git -C DIRECTORY push -u origin BRANCH`                                                  |
| Create pull request                | `gh pr create --repo owner/repo --head BRANCH --base BASE --title "..." --body-file PATH` |
| Update pull request                | `gh pr edit NUMBER --repo owner/repo [--title "..."] [--body-file PATH]`                  |
| Close pull request                 | `gh pr close NUMBER --repo owner/repo`                                                    |
| Merge pull request                 | `gh pr merge NUMBER --repo owner/repo [--merge                                            | --squash | --rebase]` |
| View pull request                  | `gh pr view NUMBER --repo owner/repo [--json ...]`                                        |
| List pull requests                 | `gh pr list --repo owner/repo [--state open                                               | closed   | merged]`   |
| Diff pull request                  | `gh pr diff NUMBER --repo owner/repo`                                                     |
| Check pull request status          | `gh pr checks NUMBER --repo owner/repo`                                                   |

## Config helpers

```bash
jr-rpc config get github.repo
jr-rpc config set github.repo owner/repo
```

## Behavior notes

- Prefer `--json` output for machine-readable parsing where available.
- Pass extra `git clone` flags after `--` (e.g. `gh repo clone owner/repo -- --depth=1`).
- Before `gh pr create`, push the head branch explicitly, then use `--head` so `gh` does not trigger hidden push/fork behavior. That push requires GitHub write access to the remote.
- If the explicit `git push` fails with 401/403 or another auth/permission error, verify the repo context and retry once. If the error still clearly indicates bad credentials, rerun the real GitHub command and let the runtime trigger a reconnect flow.
- `gh pr edit` is not a single-permission command: title/body/base/reviewer changes fit `github.pull-requests.write`; label, assignee, milestone changes fit `github.issues.write` (use the `github-issues` skill); project flags are outside the current GitHub App capability model.
- `gh pr close --comment` may need `github.issues.write` (use `github-issues`); `gh pr close --delete-branch` needs `github.contents.write`.
- Return actionable errors for auth, permission, not-found, and validation failures.
