# Slack render intents for Sentry replies

Junior's Slack runtime accepts an optional `reply` tool that renders a
structured message. Use it only when a plain mrkdwn reply would lose
information the user needs to act on. Plain-text replies without this
tool keep working unchanged — do not wrap every response in `reply`.

Call `reply` at most once per turn and treat it as the final step. The
model's ordinary assistant text is ignored when the call renders
successfully.

## When to prefer `summary_card`

Use `summary_card` when the turn returns a single Sentry issue the user
is likely to open, triage, or escalate from:

- The result of looking up a specific issue by ID or shortId.
- The top result of a search when the user's intent was clearly "find
  this one issue".

Do not use `summary_card` for:

- Multi-issue search or list results — use `result_carousel`.
- Authorization failures or an unreachable org/project — use `alert`
  with the matching severity.

## Field recipes

### Issue (`summary_card`)

```json
{
  "kind": "summary_card",
  "title": "<issue shortId> — <issue title>",
  "subtitle": "<org>/<project> · <issue.level>",
  "fields": [
    { "label": "Status", "value": "unresolved | resolved | ignored" },
    { "label": "Environment", "value": "<env>" },
    { "label": "Events", "value": "<count>" },
    { "label": "Users", "value": "<userCount>" },
    { "label": "First seen", "value": "<ISO timestamp or relative>" },
    { "label": "Last seen", "value": "<ISO timestamp or relative>" }
  ],
  "body": "<one-line culprit or short summary when useful>",
  "actions": [
    {
      "label": "View in Sentry",
      "url": "https://<org>.sentry.io/issues/<shortId>/"
    }
  ]
}
```

Guidance:

- Use the issue `shortId` (for example `ACME-4F2`) in `title`, not the
  numeric ID.
- `subtitle` carries org + project and optionally the event level
  (`error`, `warning`, `fatal`). Omit the level when it is not
  meaningful (for example transaction-only issues).
- Keep `fields` to the 3–5 most load-bearing attributes. Prefer
  `Status`, `Environment`, `Events`, `Users`, `Last seen` over raw
  metadata like project slugs that are already in `subtitle`.
- Never invent values. If a field is unknown, omit it rather than
  guessing.
- Always include a `View in Sentry` action pointing at the canonical
  issue URL.

## When to prefer other intents

- `alert` for investigation findings where urgency matters: a
  regression was detected, a spike is happening now, an issue crosses a
  noisy threshold, or Sentry access is currently blocked. Use the
  matching `severity` (`error` for active incidents, `warning` for
  regressions or elevated rates, `info` for routine findings, `success`
  for a confirmed fix).
- `result_carousel` when the turn returns a small list of issues
  (`sentry search`, top-N by frequency or users). Cap at the 5 most
  relevant entries and include the canonical Sentry URL on each. When
  the user asked for more, say so and offer a follow-up rather than
  stuffing the carousel.
- `comparison_table` only when the user explicitly asked to compare
  issues or releases side by side.

Do not use `progress_plan`. Long-running investigation steps stream
their progress through the runtime's plan channel already; they are not
a final reply.

## When not to call `reply` at all

Skip the tool entirely for ordinary prose — acknowledgements, one-line
answers, clarifying questions, or any response that naturally reads as
a single mrkdwn paragraph. The runtime renders plain assistant text as a
`plain_reply` automatically.
