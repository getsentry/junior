# API Surface

Use this reference for any Datadog operation.

## Provider surface

The packaged plugin installs Datadog's `pup` CLI and configures it for agent-mode, read-only Datadog API access. Pup defaults to JSON output, which is the right format for analysis.

Run commands as `pup --read-only --agent ...`. If a command surface is unclear, inspect `pup --read-only --agent agent schema --compact` or `pup --read-only --agent <group> --help` before guessing.

### Read-oriented commands

| Need                    | Pup command pattern                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Raw logs                | `pup --read-only --agent logs search --query="service:checkout env:prod status:error" --from="15m" --limit=20`                       |
| Log aggregation         | `pup --read-only --agent logs aggregate --query="service:checkout env:prod" --compute=count --group-by=status`                       |
| Metrics                 | `pup --read-only --agent metrics list`, `metrics search`, `metrics query`, `metrics metadata get`, `metrics tags list`               |
| Spans / traces          | `pup --read-only --agent traces search --query="service:checkout status:error" --from="15m" --limit=20`                              |
| Span aggregation        | `pup --read-only --agent traces aggregate --query="service:checkout" --compute="percentile(@duration, 95)" --group-by=resource_name` |
| APM services            | `pup --read-only --agent apm services list --env prod`, `apm services stats --env prod`                                              |
| Service dependencies    | `pup --read-only --agent apm dependencies list --env prod` or `apm flow-map --query="service:checkout"`                              |
| Monitors                | `pup --read-only --agent monitors search --query="service:checkout"`, `monitors list --tags=service:checkout`, `monitors get <id>`   |
| Incidents               | `pup --read-only --agent incidents list --query="state:active" --limit=20`, `incidents get <id>`                                     |
| Hosts                   | `pup --read-only --agent infrastructure hosts list --filter="env:prod" --count=50`, `infrastructure hosts get <host>`                |
| Dashboards              | `pup --read-only --agent dashboards list`, `dashboards get <id>`, `dashboards url <id>`                                              |
| Notebooks               | `pup --read-only --agent notebooks list`, `notebooks get <id>`                                                                       |
| RUM events and sessions | `pup --read-only --agent rum events --query='@type:error'`, `rum aggregate`, `rum sessions search`                                   |

### Commands to avoid

Do not run write commands, even with `--read-only` present:

- `create`, `update`, `delete`, `import`, `submit`, `cancel`, `mute`, `resolve`, or any command that writes a JSON file to Datadog.
- API key, app key, user, org policy, security, SLO, dashboard, monitor, incident, notebook, RUM metric, retention filter, playlist, or workflow mutations.

If a user asks for a mutation, stop and explain that this skill is read-only.

## Operation patterns

| Intent                                           | Minimum command pattern                                                                                                 |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| "Why is service X failing right now?"            | `monitors search/list` + `logs aggregate` for top errors + optionally `traces search` for representative failing spans. |
| "Show me errors for service X in the last hour." | `logs aggregate` for counts/top-N first; only use `logs search` if the user asked for specific log lines.               |
| "What is the status of monitor X?"               | `monitors search --query=...` or `monitors get <id>`, then cite state and last transition if present.                   |
| "Tell me about incident INC-123."                | `incidents get <id>` directly. Only fall back to `incidents list --query=...` if no ID is known.                        |
| "What depends on checkout?"                      | `apm dependencies list --env <env>` or `apm flow-map --query="service:checkout" --env <env>`.                           |
| "How did this trace spend its time?"             | `traces search --query="trace_id:<id>"`; cite slowest/error spans. Pup exposes span search, not a guaranteed full tree. |
| "What tag values are valid for this metric?"     | `metrics metadata get <metric>` and `metrics tags list <metric> --from=... --to=...` before `metrics query`.            |
| "Which hosts are unhealthy?"                     | `infrastructure hosts list --filter=...` with env/service/role filters.                                                 |
| "Find slow page loads."                          | `rum aggregate` or `rum events` with RUM facets and a bounded time window.                                              |

## Content expectations

- Translate Slack-thread wording into stable observability language: env, service, status, span, monitor, incident, host.
- Preserve material URLs present in the conversation when they add evidence.
- Include Datadog deep links when Pup returns them or when a stable ID-specific link is obvious.
- Label assumptions clearly when the thread leaves important details uncertain: chosen env, chosen time window, chosen service.
