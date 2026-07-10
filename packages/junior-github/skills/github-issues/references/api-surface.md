# GitHub Issue API Surface

Issue creation uses Junior's `github_createIssue` tool. Other issue operations use allowlisted REST endpoints through `gh api`; generic GraphQL-backed `gh issue` mutations are not supported.

## Repo scoping

When the user omits `owner/repo`, resolve `github.repo` first with `jr-rpc config get github.repo`, then pass the resolved repo explicitly on the actual `gh` command.
Run `jr-rpc config get github.repo` as a standalone bash command. Never chain it with `cd`, `&&`, pipes, or a `gh` command.
Treat explicit repo flags as command-targeting safety rails, not as a credential-scoping mechanism.

## GitHub App permission guidance

| Permission capability | Operations                                                                           |
| --------------------- | ------------------------------------------------------------------------------------ |
| `github.issues.read`  | `gh issue view`, `gh api /repos/.../comments`                                        |
| `github.issues.write` | `github_createIssue` and allowlisted REST issue lifecycle endpoints through `gh api` |

## Command matrix

| Operation           | Command                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| Create issue        | `github_createIssue({ repo: "owner/repo", title: "...", body: "...", labels: ["..."] })`                      |
| Update issue fields | `gh api repos/owner/repo/issues/NUMBER --method PATCH --input payload.json`                                   |
| Close issue         | `gh api repos/owner/repo/issues/NUMBER --method PATCH -f state=closed`                                        |
| Reopen issue        | `gh api repos/owner/repo/issues/NUMBER --method PATCH -f state=open`                                          |
| Add labels          | `gh api repos/owner/repo/issues/NUMBER/labels --method POST --input labels.json`                              |
| Remove label        | `gh api repos/owner/repo/issues/NUMBER/labels/LABEL --method DELETE`                                          |
| Add comment         | `gh api repos/owner/repo/issues/NUMBER/comments --method POST --input comment.json`                           |
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
- For creation, call `github_createIssue` directly instead of shelling out to `gh issue create`.
- Keep `--repo owner/repo` explicit when working across repositories.
- Return actionable errors for access, permission, not-found, and validation failures.
