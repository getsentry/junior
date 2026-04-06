# Issue Writing

Use this reference when creating a new Linear issue or substantially improving an existing one.

## Classify the work item

Infer the issue shape before drafting:

| Type | Use when | Default structure |
| ---- | -------- | ----------------- |
| `bug` | Broken behavior, regressions, failures, incidents, or user-visible defects | Summary, impact, reproduction or evidence, expected behavior |
| `feature` | Net-new capability, product expansion, or workflow improvement | Summary, current gap, desired outcome, tradeoffs or recommendation |
| `task` | Cleanup, instrumentation, docs, maintenance, follow-up, or operational work | Summary, background, scope, next step |

Default to `task` when the request does not clearly describe a defect or a net-new capability.

## Drafting rules

- Use a durable title that describes the engineering or product problem, not the Slack conversation.
- Keep the opening summary short and information-dense.
- Generalize Slack context: remove usernames, channel names, slash commands, and session chatter unless the user explicitly wants them preserved.
- Preserve material evidence already present in the thread, especially Sentry, GitHub, replay, trace, dashboard, or docs URLs.
- Include code snippets, stack traces, or exact commands only when they materially improve the future implementer's understanding.
- Keep body structure problem-specific. Use headings like `Current behavior`, `Impact`, `Reproduction`, `Expected behavior`, `Scope`, or `Recommendation` only when they help.

## Linear-specific field guidance

- Every new issue must belong to a single team. Resolve that before creating the issue.
- Set optional fields such as project, priority, labels, cycle, estimate, assignee, or status only when the user asked for them, the thread gives clear evidence, or the team's workflow makes the choice obvious.
- Do not invent a custom status name. If you need a non-default status, read the team's actual workflow states first.
- Priority should stay within Linear's standard levels: `low`, `medium`, `high`, `urgent`.
- Estimates are team-configured. Only set one when the thread provides a clear value or the team context already makes the estimate scale unambiguous.
- Labels may be workspace- or team-scoped. Reuse an existing matching label when possible instead of introducing near-duplicates.

## Duplicate handling

- Search silently before creating a new issue when the request appears related to existing work.
- If a clear duplicate exists, prefer updating or commenting on the existing issue instead of creating a new one.
- If the user explicitly wants a separate tracking issue anyway, state the relationship clearly in the new issue.

## Result reporting

- Report only the final, durable result: issue key, canonical URL, and what changed.
- Keep routine drafting, search, and mutation steps silent unless they materially affect the outcome.
