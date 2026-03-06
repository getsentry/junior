# GitHub CLI Command Reference

All issue operations should go through `gh` CLI commands.

## Authentication

- Preferred: sandbox network policy injects Authorization headers for `api.github.com`.
- Optional local fallback: `GITHUB_TOKEN` (short-lived GitHub App installation token).
- If `GITHUB_TOKEN` is a host placeholder value, rely on header transforms and do not override it.

## Command shapes

### Create issue

`gh issue create --repo owner/repo --title "..." [--body-file /tmp/issue.md]`

### Update title/body

`gh issue edit 123 --repo owner/repo [--title "..."] [--body-file /tmp/issue.md]`

### Close issue

`gh issue close 123 --repo owner/repo [--comment "..."]`

### Reopen issue

`gh issue reopen 123 --repo owner/repo`

### Add labels

`gh issue edit 123 --repo owner/repo --add-label bug --add-label regression`

### Remove labels

`gh issue edit 123 --repo owner/repo --remove-label triage`

### Add comment

`gh issue comment 123 --repo owner/repo --body-file /tmp/comment.md`

### Get issue JSON

`gh issue view 123 --repo owner/repo --json number,title,state,labels,assignees,author,url,body`

### List comments JSON (read-only)

`gh api /repos/owner/repo/issues/123/comments --method GET --header "Accept: application/vnd.github+json"`

## Behavior notes

- Prefer `--json` output for machine-readable parsing where available.
- Use `gh api` for endpoints not fully covered by `gh issue` subcommands.
- Commands should be deterministic and non-interactive in harness usage.
- Return actionable errors for auth, permission, not-found, and validation failures.
