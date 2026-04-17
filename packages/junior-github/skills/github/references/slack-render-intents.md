# Slack render intents for GitHub replies

Junior's Slack runtime accepts an optional `reply` tool that renders a
structured message. Use it only when a plain mrkdwn reply would lose
information the user needs to act on. Plain-text replies without this
tool keep working unchanged — do not wrap every response in `reply`.

Call `reply` at most once per turn and treat it as the final step. The
model's ordinary assistant text is ignored when the call renders
successfully.

## When to prefer `summary_card`

Use `summary_card` when the turn returns a single GitHub entity the user
is likely to open or take an action on:

- The result of `gh pr view`, `gh pr create`, or `gh pr diff` on a
  specific pull request.
- The result of `gh issue view` or `gh issue create` on a specific issue.

Do not use `summary_card` for:

- Search results across multiple PRs or issues — use `result_carousel`.
- Failure or blocked states — use `alert` with the matching severity.
- Multi-line status narratives that have no clear single entity.

## Field recipes

### Pull request (`summary_card`)

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

Guidance:

- Populate `title` with the PR number and upstream title; do not
  paraphrase the upstream title.
- Use `subtitle` for repo + branch context only. Do not restate
  information already in `fields`.
- Keep `fields` to the 3–5 most load-bearing attributes. Omit any field
  you cannot fill from real data; never invent values.
- Keep `body` short. Long PR descriptions belong behind the "View PR"
  action, not inlined into Slack.
- Always include a `View PR` action pointing at the canonical PR URL.
- Add a second action (`View diff`, `View checks`) only when the turn
  specifically produced that artifact.

### Issue (`summary_card`)

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

## When to prefer other intents

- `alert` when reporting that a command failed, credentials are missing,
  or a PR cannot be merged yet. Use the matching `severity`.
- `result_carousel` when the turn lists multiple PRs or issues (e.g.
  `gh pr list`, `gh search issues`). Each item is one entity, with the
  same shape as a `summary_card` scaled down.
- `comparison_table` when the user asked for a diff-style comparison
  across two or more PRs/branches/releases.

Do not use `progress_plan`. Long-running work streams its progress
through the runtime's plan channel already; it is not a final reply.

## When not to call `reply` at all

Skip the tool entirely for ordinary prose — acknowledgements, one-line
answers, clarifying questions, or any response that naturally reads as
a single mrkdwn paragraph. The runtime renders plain assistant text as a
`plain_reply` automatically. Calling `reply({ kind: "plain_reply", ... })`
is only appropriate when the model wants to explicitly route a plain
response through the same rendering path as richer intents (rare).
