# GitHub Issue API Helper

All issue mutations should go through:

`node src/junior/skills/gh-issue/scripts/gh_issue_api.mjs <command> [options]`

## Required Environment Variables

- `GITHUB_TOKEN` (short-lived GitHub App installation token)

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

## Behavior Notes

- Outputs JSON for machine-friendly consumption.
- Uses GitHub App installation tokens, so actions are attributed to the app identity.
- Returns actionable errors for auth, permission, not-found, and validation failures.
- Requires per-command `GITHUB_TOKEN` injection.
