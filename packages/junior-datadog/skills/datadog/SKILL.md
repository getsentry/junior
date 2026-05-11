---
name: datadog
description: Query live Datadog telemetry (logs, metrics, traces, spans, monitors, incidents, dashboards, services, hosts) through Datadog's Pup CLI. Use when users ask to investigate production behavior in Datadog, including searching logs, checking monitor status, inspecting traces or spans, looking up incidents, finding services, or correlating metrics. Do not use it for Sentry issues, repository/source-code work, or ticketing.
---

# Datadog Operations

Use this skill for read-only Datadog observability investigations.

## Reference loading

Load references conditionally based on the request:

| Need                                               | Read                                                                                                                       |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Any Datadog operation                              | [references/api-surface.md](references/api-surface.md)                                                                     |
| Log search, metric query, trace lookup, incidents  | [references/common-use-cases.md](references/common-use-cases.md), [references/query-syntax.md](references/query-syntax.md) |
| Auth failures, permission errors, or tool failures | [references/troubleshooting-workarounds.md](references/troubleshooting-workarounds.md)                                     |

## Workflow

1. Resolve the operation and target:

- Determine whether the request is a log search, metric query, trace/span inspection, monitor lookup, incident lookup, dashboard/notebook lookup, service/host listing, or service-dependency map.
- Prefer explicit env, service, host, monitor/incident IDs, trace IDs, or Datadog URLs when the user provides them.
- When the user did not specify a scope, treat `datadog.env` and `datadog.service` conversation config as optional defaults. Explicit user input always wins over config.
- Only set or change `datadog.env` and `datadog.service` when the user explicitly asks to store a default for this conversation or channel.
- If the request refers to an earlier telemetry item indirectly, inspect the current thread for the existing ID or URL before asking the user to restate it.
- Ask one concise follow-up only when a search is genuinely under-specified, for example when the user asks about "errors" with no env, service, or time window hint and the thread has no prior context.

- If an active repository context exists (cloned repo or configured `github.repo`), check the repo root for `TELEMETRY.md` before forming queries. When present, use its query recipes, service/env mappings, and investigation pivots as repo-specific guidance. Explicit user targets, IDs, URLs, and conversation config still win. If absent, continue normally.

2. Use Pup:

- Run Datadog commands with `pup --read-only --agent ...`. The plugin also sets read-only/agent env vars, but include the flags so command transcripts show the intended mode.
- If you are unsure about a command or flag, inspect Pup's schema with `pup --read-only --agent agent schema --compact` or the relevant `pup --read-only --agent <group> --help` output before guessing.
- Start narrow: pick the single most direct command for the request before broader search.
  - Known incident ID: `pup --read-only --agent incidents get <incident_id>`
  - Known monitor ID: `pup --read-only --agent monitors get <monitor_id>`
  - Known notebook ID: `pup --read-only --agent notebooks get <notebook_id>`
  - Known metric name: `pup --read-only --agent metrics query --query="avg:<metric>{...}" --from="15m" --to="now"`; use `metrics metadata get` or `metrics tags list` when the user wants available tags or dimensions.
- For exploratory questions, prefer one focused Pup search/list/aggregate command, then one follow-up fetch if needed.
- For "current error rate / log volume / top offenders" questions, prefer `pup logs aggregate` over pulling raw log pages back through `pup logs search`.
- For service-topology questions ("what calls checkout?", "what does the payment API depend on?"), prefer `pup apm dependencies list` or `pup apm flow-map` over stitching spans together manually.
- Use `pup monitors search` or `pup monitors list` for "is this alerting?" and `pup incidents list` / `pup incidents get` for incident context.
- Use RUM commands only when the user asks about real-user / browser telemetry, not for backend issues.

3. Bound every query:

- Always constrain time windows. Default to the last 15 minutes for "right now" questions and the last 24 hours for retrospective questions; otherwise use the window the user named.
- Always include `env:` when `datadog.env` is set or the user named an env.
- Always include `service:` when the user named a service or `datadog.service` is set and the command is service-scoped.
- Cap result size. Prefer the default or small page sizes; do not page through thousands of logs when an aggregate command answers the question.

4. Report the result:

- Return the concrete answer first (counts, status, incident severity, trace timing, top offenders), then a short evidence block.
- Include Datadog deep links when Pup returns them or when you can construct a stable app link from an ID. Do not fabricate links from incomplete identifiers.
- Preserve interesting spans, log lines, or metric values inline only when they are evidence for the answer. Do not dump raw command output.
- Keep routine tool chatter silent. Do not narrate every Pup search or fetch step.

## Guardrails

- Read-only only in this skill. Do not create, edit, mute, delete, import, submit, or resolve monitors, incidents, notebooks, dashboards, SLOs, metrics, API keys, RUM resources, or other Datadog objects.
- Log, RUM, APM, and incident payloads can contain PII or sensitive customer data. Quote only the minimum needed to answer the question. Do not paste full raw log bodies or span payloads when a summary plus a deep link is enough.
- If Pup returns `403`, `permission denied`, or similar, stop and tell the user the Datadog credentials could not access the requested resource. Do not guess at missing RBAC scopes.
- If Datadog responds with `429 Too Many Requests`, wait briefly and retry the same query once. If it still fails, report the throttle and stop.
- For large traces or span responses that are incomplete, report that fact; do not pretend the shown spans are complete.
- Do not use this skill for Sentry issues, Linear/GitHub ticketing, or source-code investigation. Hand those off to the matching skill.
