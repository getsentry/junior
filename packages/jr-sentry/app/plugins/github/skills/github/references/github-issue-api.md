# GitHub Issue API Helper

All issue operations should go through:

`node /vercel/sandbox/skills/github/scripts/gh_issue_api.mjs <command> [options]`

## Authentication

- Preferred: sandbox network policy injects Authorization headers for `api.github.com`.
- Optional local fallback: `GITHUB_TOKEN` (short-lived GitHub App installation token).

## Commands

### Create issue

`node .../gh_issue_api.mjs create --repo owner/repo --title "..." --body-file /tmp/issue.md`

### Update issue fields

`node .../gh_issue_api.mjs update --repo owner/repo --number 123 --title "..." --body-file /tmp/issue.md --state open|closed`

### Add comment

`node .../gh_issue_api.mjs comment --repo owner/repo --number 123 --body-file /tmp/comment.md`

### Add labels

`node .../gh_issue_api.mjs add-labels --repo owner/repo --number 123 --labels bug,regression`

### Remove labels

`node .../gh_issue_api.mjs remove-labels --repo owner/repo --number 123 --labels triage`

### Get issue (read-only)

`node .../gh_issue_api.mjs get --repo owner/repo --number 123`

### List issue comments (read-only)

`node .../gh_issue_api.mjs list-comments --repo owner/repo --number 123`

## Behavior Notes

- Outputs JSON for machine-friendly consumption.
- Uses GitHub App installation tokens, so actions are attributed to the app identity.
- Returns actionable errors for auth, permission, not-found, and validation failures.
- In harness runtime, auth should come from scoped header transforms, not raw token env injection.
