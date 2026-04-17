# Slack render-intent recipes for GitHub

Field recipes for GitHub domain objects. The core `<render-capabilities>`
system prompt already defines the intent palette, when to pick each kind,
and when to skip the `reply` tool entirely. This file only adds the
GitHub-specific recipes.

## Pull request (`summary_card`)

Use for the result of `gh pr view`, `gh pr create`, or `gh pr diff` on a
specific pull request.

```json
{
  "kind": "summary_card",
  "title": "PR #<number> — <PR title>",
  "subtitle": "<owner>/<repo> · <head branch> → <base branch>",
  "fields": [
    { "label": "Status", "value": "Open | Merged | Closed | Draft" },
    { "label": "Author", "value": "<login>" },
    { "label": "Reviewers", "value": "<login>, <login>" },
    { "label": "Checks", "value": "<n> passing / <n> failing / <n> pending" },
    { "label": "Files changed", "value": "<n>" }
  ],
  "body": "<one-to-two-sentence summary of what the PR does>",
  "actions": [
    {
      "label": "View PR",
      "url": "https://github.com/<owner>/<repo>/pull/<number>"
    }
  ]
}
```

- Populate `title` with the PR number and upstream title; do not paraphrase the upstream title.
- Use `subtitle` for repo + branch context only. Do not restate information already in `fields`.
- Keep `fields` to the 3–5 most load-bearing attributes. Omit any field you cannot fill from real data; never invent values.
- Keep `body` short. Long PR descriptions belong behind the "View PR" action, not inlined into Slack.
- Always include a `View PR` action pointing at the canonical PR URL.
- Add a second action (`View diff`, `View checks`) only when the turn specifically produced that artifact.

## Issue (`summary_card`)

Use for the result of `gh issue view` or `gh issue create` on a specific
issue.

```json
{
  "kind": "summary_card",
  "title": "#<number> — <issue title>",
  "subtitle": "<owner>/<repo>",
  "fields": [
    { "label": "State", "value": "Open | Closed" },
    { "label": "Labels", "value": "<label>, <label>" },
    { "label": "Author", "value": "<login>" }
  ],
  "body": "<one-to-two-sentence summary of the issue>",
  "actions": [
    {
      "label": "View issue",
      "url": "https://github.com/<owner>/<repo>/issues/<number>"
    }
  ]
}
```

## Multi-entity and error responses

- `gh pr list`, `gh search issues`, `gh search prs` → `result_carousel`, each item scaled down from the `summary_card` recipe above. Cap at 5 items and offer a follow-up for more.
- Command failures, auth failures, merge-not-allowed states → `alert` with the matching severity (`error` for hard failures, `warning` for policy blocks, `info` for advisory results).
- Two-or-more-branch / two-or-more-PR diffs the user explicitly asked to compare → `comparison_table` with short cells.
