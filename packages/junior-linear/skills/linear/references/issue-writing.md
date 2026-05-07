# Issue Writing

Load when creating a new Linear issue or substantially rewriting one. Cross-type rules (title length, delegated footer, generalization, compression) live in `SKILL.md` § Draft issue content — this file covers classification, title phrasing, and Linear-specific fields only.

## Classify the work item

| Type      | Use when                                                                    |
| --------- | --------------------------------------------------------------------------- |
| `bug`     | Broken behavior, regressions, failures, incidents, or user-visible defects  |
| `feature` | Net-new capability, product expansion, or workflow improvement              |
| `task`    | Cleanup, instrumentation, docs, maintenance, follow-up, or operational work |

Default to `task` when the request does not clearly describe a defect or a net-new capability. Structure matches complexity — simple issues need a few bullets; complex bugs may warrant headed sections.

## Title phrasing

- Bug: short description of the broken behavior — e.g. "Webhook delivery drops events over 256KB"
- Task: short imperative command — e.g. "Add rate-limit headers to ingest endpoint"
- Feature: short imperative describing the capability — e.g. "Support SAML SSO for enterprise orgs"

## Linear-specific field guidance

- Every new issue must belong to a single team. Resolve that before creating the issue.
- If the request maps to a known team template and the active MCP tools expose template-based creation, prefer the template so the team's default properties are applied consistently.
- Do not invent a custom status name. Read the team's actual workflow states first when a non-default status is needed.
- Priority stays within Linear's standard levels: `low`, `medium`, `high`, `urgent`.
- Estimates are team-configured. Set one only when the thread provides a clear value or the team context makes the scale unambiguous.
- Labels may be workspace- or team-scoped. Reuse an existing matching label instead of introducing near-duplicates.
- If the tool exposes structured link attachments, attach important URLs there and keep the prose body focused on interpretation.

## Duplicate handling

- Search silently before creating a new issue when the request appears related to existing work.
- Prefer updating or commenting on a clear duplicate rather than creating a new issue.
- If the user explicitly wants a separate tracking issue, state the relationship in the new issue.
