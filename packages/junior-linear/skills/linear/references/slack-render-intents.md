# Slack render intents for Linear replies

Junior's Slack runtime accepts an optional `reply` tool that renders a
structured message. Use it only when a plain mrkdwn reply would lose
information the user needs to act on. Plain-text replies without this
tool keep working unchanged — do not wrap every response in `reply`.

Call `reply` at most once per turn and treat it as the final step. The
model's ordinary assistant text is ignored when the call renders
successfully.

## When to prefer `summary_card`

Use `summary_card` when the turn returns a single Linear entity the user
is likely to open or take an action on:

- The result of viewing, creating, updating, or commenting on a specific
  Linear issue.
- The result of viewing or updating a specific Linear project when it is
  the sole entity in the reply.

Do not use `summary_card` for:

- Multi-issue search or backlog results — use `result_carousel`.
- Failure or authorization states — use `alert` with the matching
  severity.
- Pure prose responses that do not resolve to a single entity.

## Field recipes

### Issue (`summary_card`)

```json
{
  "kind": "summary_card",
  "title": "<ISSUE-KEY> — <issue title>",
  "subtitle": "<team name> · <project name>",
  "fields": [
    { "label": "Status", "value": "<workflow state>" },
    { "label": "Priority", "value": "<urgent|high|medium|low|no priority>" },
    { "label": "Assignee", "value": "<assignee name or 'Unassigned'>" },
    { "label": "Estimate", "value": "<points or time>" },
    { "label": "Labels", "value": "<label>, <label>" }
  ],
  "body": "<one-to-two-sentence summary of the work>",
  "actions": [
    {
      "label": "View in Linear",
      "url": "https://linear.app/<workspace>/issue/<ISSUE-KEY>"
    }
  ]
}
```

Guidance:

- Use the canonical Linear key (for example `ENG-1234`) in `title`, not
  a numeric ID or paraphrase.
- `subtitle` is for team and project context. Omit project when the
  issue has none; never invent one.
- Keep `fields` to the 3–5 most load-bearing attributes. Prefer
  `Status`, `Priority`, and `Assignee` over pure metadata like `Created`
  or `Updated` unless the user asked about timing.
- Do not invent workflow state names. Use the team's actual state (for
  example `In Review`), not generic substitutes.
- Always include a `View in Linear` action pointing at the canonical
  issue URL.

### Project (`summary_card`)

```json
{
  "kind": "summary_card",
  "title": "<project name>",
  "subtitle": "<team name>",
  "fields": [
    { "label": "Status", "value": "<project status>" },
    { "label": "Lead", "value": "<lead name or 'Unassigned'>" },
    { "label": "Target date", "value": "<YYYY-MM-DD or 'None'>" },
    { "label": "Progress", "value": "<n>% complete" }
  ],
  "body": "<one-to-two-sentence project summary>",
  "actions": [
    {
      "label": "Open project",
      "url": "https://linear.app/<workspace>/project/<slug>"
    }
  ]
}
```

## When to prefer other intents

- `result_carousel` when the turn returns a small list of issues
  (backlog slice, assignee query, triage queue). Each item carries the
  issue key, status, and a link to the issue. Cap at the 5 most relevant
  items; ask a follow-up when the user clearly wants more.
- `alert` when the turn reports that the Linear MCP is not authorized,
  a write was rejected, or the requested issue cannot be found. Use the
  matching `severity` (`error`, `warning`, `info`).
- `comparison_table` only when the user explicitly asked for a
  side-by-side comparison across issues or projects.

Do not use `progress_plan`. Long-running work streams its progress
through the runtime's plan channel already; it is not a final reply.

## When not to call `reply` at all

Skip the tool entirely for ordinary prose — acknowledgements, one-line
answers, clarifying questions, or any response that naturally reads as
a single mrkdwn paragraph. The runtime renders plain assistant text as a
`plain_reply` automatically.
