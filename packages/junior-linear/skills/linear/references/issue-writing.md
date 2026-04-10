# Issue Writing

Use this reference when creating a new Linear issue or substantially improving an existing one.

## Classify the work item

Infer the issue type before drafting:

| Type      | Use when                                                                    |
| --------- | --------------------------------------------------------------------------- |
| `bug`     | Broken behavior, regressions, failures, incidents, or user-visible defects  |
| `feature` | Net-new capability, product expansion, or workflow improvement              |
| `task`    | Cleanup, instrumentation, docs, maintenance, follow-up, or operational work |

Default to `task` when the request does not clearly describe a defect or a net-new capability. Structure should match complexity — simple issues need only a few bullets, complex bugs may warrant headed sections.

## Title rules

- Bug: short description of the broken behavior (e.g. "Webhook delivery drops events over 256KB")
- Task: short imperative command (e.g. "Add rate-limit headers to ingest endpoint")
- Feature: short imperative describing the capability (e.g. "Support SAML SSO for enterprise orgs")

## Drafting rules

- Use terse, specific language. No filler phrases, no restating the title in the body.
- Specify who raised the issue when clear from the thread (e.g. "Reported by a customer in #support" or "Flagged by the oncall engineer").
- Attach screenshots from the thread as image links when present.
- Link relevant domain info (Sentry issues, GitHub PRs, docs pages, dashboards) inline where context helps — do not dump a link list.
- Use bullet lists for multi-item details. Omit section headings when a flat list is sufficient.
- Do not add a desired outcome or expected behavior section unless the thread explicitly states one.
- Generalize Slack context: remove channel names, slash commands, and session chatter unless the user explicitly wants them preserved.
- Include code snippets, stack traces, or exact commands only when they materially improve understanding.

## Linear-specific field guidance

- Every new issue must belong to a single team. Resolve that before creating the issue.
- If the request clearly maps to a known team template and the active MCP tools expose template-based creation, prefer the template so the team's default properties are applied consistently.
- Set optional fields such as project, priority, labels, cycle, estimate, assignee, or status only when the user asked for them, the thread gives clear evidence, or the team's workflow makes the choice obvious.
- Do not invent a custom status name. If you need a non-default status, read the team's actual workflow states first.
- Priority should stay within Linear's standard levels: `low`, `medium`, `high`, `urgent`.
- Estimates are team-configured. Only set one when the thread provides a clear value or the team context already makes the estimate scale unambiguous.
- Labels may be workspace- or team-scoped. Reuse an existing matching label when possible instead of introducing near-duplicates.
- If the tool exposes structured link attachments, attach the important URLs there and keep the prose body focused on interpretation rather than raw link dumping.

## Delegated action footer

When creating a new issue on behalf of a user, append a final line:

`Action taken on behalf of <name>.`

## Pre-creation checklist

Before submitting, verify:

- Title is type-appropriate (descriptive for bugs, imperative for tasks/features)
- Body uses flat bullets where headings aren't needed
- No desired outcome section unless the thread stated one
- Reporter is mentioned when known
- Screenshots and domain links are attached when present in thread
- No session-specific noise (channel names, slash commands, conversational filler)

## Duplicate handling

- Search silently before creating a new issue when the request appears related to existing work.
- If a clear duplicate exists, prefer updating or commenting on the existing issue instead of creating a new one.
- If the user explicitly wants a separate tracking issue anyway, state the relationship clearly in the new issue.

## Result reporting

- Report only the final, durable result: issue key, canonical URL, and what changed.
- Keep routine drafting, search, and mutation steps silent unless they materially affect the outcome.
