# Slack render-intent recipes for Linear

Field recipes for Linear domain objects. The core `<render-capabilities>`
system prompt already defines the intent palette, when to pick each kind,
and when to skip the `reply` tool entirely. This file only adds the
Linear-specific recipes.

## Issue (`summary_card`)

Use for a single Linear issue returned by a view, create, update, or
comment action.

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

- Use the canonical Linear key (for example `ENG-1234`) in `title`, not a numeric ID or paraphrase.
- `subtitle` is for team and project context. Omit project when the issue has none; never invent one.
- Keep `fields` to the 3–5 most load-bearing attributes. Prefer `Status`, `Priority`, and `Assignee` over pure metadata like `Created` or `Updated` unless the user asked about timing.
- Do not invent workflow state names. Use the team's actual state (for example `In Review`), not generic substitutes.
- Always include a `View in Linear` action pointing at the canonical issue URL.

## Project (`summary_card`)

Use for a single Linear project when it is the sole entity in the reply.

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

## Multi-entity and error responses

- Backlog slices, assignee queries, triage queues → `result_carousel`, each item carrying the issue key, status, and a link to the issue. Cap at 5 items and offer a follow-up for more.
- Linear MCP auth failures, rejected writes, missing-entity responses → `alert` with the matching severity (`error`, `warning`, `info`).
- Explicit user-requested side-by-side comparisons across issues or projects → `comparison_table` with short cells.
