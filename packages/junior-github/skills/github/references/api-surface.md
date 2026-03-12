# GitHub CLI API Surface

This skill supports issue workflows plus repository checkout via `gh repo clone`.

All operations use `gh` CLI.

## Capability to command mapping

| Capability | Commands |
| --- | --- |
| none required | `gh repo clone` |
| `github.issues.read` | `gh issue view`, `gh api /repos/.../comments` |
| `github.issues.write` | `gh issue create`, `gh issue edit`, `gh issue close`, `gh issue reopen` |
| `github.issues.comment` | `gh issue comment` |
| `github.labels.write` | `gh issue edit --add-label/--remove-label` |

## Command matrix

| Operation | Command |
| --- | --- |
| Clone repository (default shallow) | `gh repo clone owner/repo [DIRECTORY] -- --depth=1` |
| Deepen shallow clone | `git -C DIRECTORY fetch --depth=N origin` |
| Convert shallow clone to full | `git -C DIRECTORY fetch --unshallow` |
| Create issue | `gh issue create --repo owner/repo --title "..." [--body-file PATH]` |
| Update issue fields | `gh issue edit NUMBER --repo owner/repo [--title "..."] [--body-file PATH]` |
| Close issue | `gh issue close NUMBER --repo owner/repo [--comment "..."]` |
| Reopen issue | `gh issue reopen NUMBER --repo owner/repo` |
| Add labels | `gh issue edit NUMBER --repo owner/repo --add-label LABEL [--add-label LABEL2]` |
| Remove labels | `gh issue edit NUMBER --repo owner/repo --remove-label LABEL [--remove-label LABEL2]` |
| Add comment | `gh issue comment NUMBER --repo owner/repo --body-file PATH` |
| Read issue | `gh issue view NUMBER --repo owner/repo --json number,title,state,labels,assignees,author,url,body` |
| Read comments | `gh api /repos/owner/repo/issues/NUMBER/comments --method GET --header "Accept: application/vnd.github+json"` |

## Credential + config helper commands

Resolve repo default:

```bash
jr-rpc config get github.repo
```

Set repo default:

```bash
jr-rpc config set github.repo owner/repo
```

Pass extra `git clone` flags after `--`:

```bash
gh repo clone owner/repo -- --depth=1 --filter=blob:none
```

Issue scoped credentials:

```bash
jr-rpc issue-credential github.issues.read
jr-rpc issue-credential github.issues.write
jr-rpc issue-credential github.issues.comment
jr-rpc issue-credential github.labels.write
```
