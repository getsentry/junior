# GitHub CLI API Surface — issues

All operations use `gh` CLI. Commands must be deterministic and non-interactive.

## Repo scoping

When the user omits `owner/repo`, resolve `github.repo` first with `jr-rpc config get github.repo`, then pass the resolved repo explicitly on the actual `gh` command.
Run `jr-rpc config get github.repo` as a standalone bash command. Never chain it with `cd`, `&&`, pipes, or a `gh` command.
Treat explicit repo flags as command-targeting safety rails, not as a credential-scoping mechanism.

## Capability to command mapping

| Capability            | Commands                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `github.issues.read`  | `gh issue view`, `gh api /repos/.../comments`                                               |
| `github.issues.write` | `gh issue create`, `gh issue edit`, `gh issue comment`, `gh issue close`, `gh issue reopen` |

## Command matrix

| Operation           | Command                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| Create issue        | `gh issue create --repo owner/repo --title "..." --body-file PATH`                                            |
| Update issue fields | `gh issue edit NUMBER --repo owner/repo [--title "..."] [--body-file PATH]`                                   |
| Close issue         | `gh issue close NUMBER --repo owner/repo [--comment "..."]`                                                   |
| Reopen issue        | `gh issue reopen NUMBER --repo owner/repo`                                                                    |
| Add labels          | `gh issue edit NUMBER --repo owner/repo --add-label LABEL [--add-label LABEL2]`                               |
| Remove labels       | `gh issue edit NUMBER --repo owner/repo --remove-label LABEL [--remove-label LABEL2]`                         |
| Add comment         | `gh issue comment NUMBER --repo owner/repo --body-file PATH`                                                  |
| List issues         | `gh issue list --repo owner/repo --json number,title,state,url --limit 20`                                    |
| Read issue          | `gh issue view NUMBER --repo owner/repo --json number,title,state,labels,assignees,author,url,body`           |
| Read comments       | `gh api /repos/owner/repo/issues/NUMBER/comments --method GET --header "Accept: application/vnd.github+json"` |

## Config helpers

```bash
jr-rpc config get github.repo
jr-rpc config set github.repo owner/repo
```

## Behavior notes

- Prefer `--json` output for machine-readable parsing where available.
- Use `gh api` for endpoints not fully covered by `gh issue` subcommands.
- For automation, always fully specify `gh issue create` with `--title` and `--body` or `--body-file`; never rely on interactive prompts.
- Keep `--repo owner/repo` explicit when working across repositories.
- Return actionable errors for auth, permission, not-found, and validation failures.
