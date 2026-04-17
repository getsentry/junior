# Slack render-intent recipes for Sentry

Field recipes for Sentry domain objects. The core `<render-capabilities>`
system prompt already defines the intent palette, when to pick each kind,
and when to skip the `reply` tool entirely. This file only adds the
Sentry-specific recipes.

## Issue (`summary_card`)

Use for a single Sentry issue returned by a view, search, or assignment
action when it is the sole entity in the reply.

```json
{
  "kind": "summary_card",
  "title": "<SHORT-ID> — <issue title>",
  "subtitle": "<org slug> · <project slug>",
  "fields": [
    { "label": "Level", "value": "<error|warning|info|fatal>" },
    { "label": "Status", "value": "<unresolved|resolved|ignored|archived>" },
    { "label": "Events", "value": "<count>" },
    { "label": "Users", "value": "<user count>" },
    { "label": "Assignee", "value": "<assignee name or 'Unassigned'>" }
  ],
  "body": "<one-to-two-sentence summary of what the issue is and the user impact>",
  "actions": [
    {
      "label": "Open in Sentry",
      "url": "https://sentry.io/organizations/<org-slug>/issues/<issue-id>/"
    }
  ]
}
```

- Use the issue's `shortId` (for example `JAVASCRIPT-1A2B`) in `title`, not the numeric internal ID.
- `subtitle` is for org + project context. Omit a field rather than inventing one.
- Keep `fields` to the 3–5 most load-bearing attributes. Level, status, and event/user counts are usually the most useful; skip any that the API did not return.
- Do not invent status values or level names. Use the exact strings Sentry returned.
- Always include an `Open in Sentry` action pointing at the canonical issue URL.

## Multi-entity and error responses

- Multi-issue search results, top-N queries, or recent-issue digests → `result_carousel`, each item scaled down from the `summary_card` recipe above. Cap at 5 items and offer a follow-up for more.
- Sentry MCP auth failures, rate-limit responses, or rejected writes → `alert` with the matching severity (`error`, `warning`, `info`).
- Explicit user-requested side-by-side comparisons across issues or environments → `comparison_table` with short cells.
