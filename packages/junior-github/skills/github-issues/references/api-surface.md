# GitHub Issue API Surface

Issue creation uses `github_createIssue`, one-issue reads use `github_getIssue`, title, body, and state updates use `github_updateIssue`, and new comments use `github_commentOnIssue`. Comment reads, labels, assignees, and issue lists use `gh`; generic GraphQL-backed `gh issue` mutations are not supported.

## Repo scoping

When the user omits `owner/repo`, resolve `github.repo` first with `jr-rpc config get github.repo`, then pass the resolved repo explicitly on the actual `gh` command.
Run `jr-rpc config get github.repo` as a standalone bash command. Never chain it with `cd`, `&&`, pipes, or a `gh` command.
Treat explicit repo flags as command-targeting safety rails, not as a credential-scoping mechanism.

## GitHub App permission guidance

| Permission capability | Operations                                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| `github.issues.read`  | `github_getIssue`, `gh api /repos/.../comments`                                                             |
| `github.issues.write` | Typed issue create, update, and comment tools, and allowlisted label or assignee endpoints through `gh api` |

## Command matrix

| Operation           | Command                                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Create issue        | `github_createIssue({ repo: "owner/repo", title: "...", body: "...", labels: ["..."] })`                              |
| Update issue fields | `github_updateIssue({ repo: "owner/repo", number: NUMBER, title?: "...", body?: "...", state?: "open" \| "closed" })` |
| Close issue         | `github_updateIssue({ repo: "owner/repo", number: NUMBER, state: "closed" })`                                         |
| Reopen issue        | `github_updateIssue({ repo: "owner/repo", number: NUMBER, state: "open" })`                                           |
| Add labels          | `gh api repos/owner/repo/issues/NUMBER/labels --method POST --input labels.json`                                      |
| Remove label        | `gh api repos/owner/repo/issues/NUMBER/labels/LABEL --method DELETE`                                                  |
| Add assignees       | `gh api repos/owner/repo/issues/NUMBER/assignees --method POST --input assignees.json`                                |
| Remove assignees    | `gh api repos/owner/repo/issues/NUMBER/assignees --method DELETE --input assignees.json`                              |
| Add comment         | `github_commentOnIssue({ repo: "owner/repo", number: NUMBER, body: "..." })`                                          |
| List issues         | `gh issue list --repo owner/repo --json number,title,state,url --limit 20`                                            |
| Read issue          | `github_getIssue({ repo: "owner/repo", number: NUMBER })`                                                             |
| Read comments       | `gh api /repos/owner/repo/issues/NUMBER/comments --method GET --header "Accept: application/vnd.github+json"`         |

## Config helpers

```bash
jr-rpc config get github.repo
jr-rpc config set github.repo owner/repo
```

## Behavior notes

- Prefer `--json` output for machine-readable parsing where available.
- Use `gh api` for endpoints not fully covered by `gh issue` subcommands.
- For creation, call `github_createIssue` directly instead of shelling out to `gh issue create`.
- Use `github_updateIssue` for title, body, or state changes. Raw issue PATCH is denied because GitHub also uses that endpoint for pull requests.
- Use the dedicated assignees endpoint for assignment changes. Do not send `assignees` through `github_updateIssue`.
- Keep `--repo owner/repo` explicit when working across repositories.
- Return actionable errors for access, permission, not-found, and validation failures.
