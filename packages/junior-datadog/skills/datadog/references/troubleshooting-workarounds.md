# Troubleshooting and Workarounds

Use this reference when Datadog MCP calls fail or return unexpected results.

## Authentication and connection

| Symptom                                                            | Likely cause                                                | What to do                                                                                                                     |
| ------------------------------------------------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Tool call returns an authorization-required signal before running. | User has not yet completed the Datadog OAuth flow in Slack. | Let the runtime DM the user the authorization link and pause the turn. Do not prompt for credentials manually.                 |
| Tool call returned `401` mid-session.                              | OAuth token expired or was revoked.                         | Expect Junior's MCP layer to resurface the authorization flow. Retry once the user has re-authorized; do not loop before that. |
| OAuth callback did not resume the thread.                          | User closed the browser before the redirect completed.      | Ask the user to retry the request — the OAuth flow will restart and complete if they finish it this time.                      |

## Permission and scope errors

- A Datadog API returning `403 Forbidden` or `permission denied` means the user's Datadog role cannot read that resource (metrics, APM, incidents, RUM, etc.).
- Stop and tell the user the current Datadog connection could not access the requested data. Suggest they verify their Datadog role/team.
- Do not guess specific missing permission names unless Datadog explicitly named one in the error.
- Do not loop retrying a 403.

## Rate limits

- Datadog throttles the unstable MCP endpoint. A `429 Too Many Requests` response is expected under load.
- Retry the same query once after a short wait.
- If it fails again, report the throttle and stop. Do not fall back to larger scans that will throttle harder.

## Query returned no results

- Double-check that `env:` and `service:` match real values. Datadog tag values are case-sensitive.
- Widen the time window before widening the filter. Many "no results" cases are just too narrow a window.
- If searching logs with `@<field>:value`, confirm the field exists as a facet; custom log attributes must be facetized in Datadog to be searchable.
- If an expected monitor or incident is missing, the user's account may not have access to that workspace or team.

## Too many results / large payloads

- Prefer `analyze_datadog_logs` with `GROUP BY` + `LIMIT` over paging raw logs.
- For traces marked truncated by the server, say so in the reply. Do not pretend the shown spans are complete.
- Quote only the minimum log / span / metric content needed as evidence. Link to Datadog for the rest.

## Multiple Datadog sites

- The packaged plugin defaults to the US1 endpoint (`mcp.datadoghq.com`). The manifest declares `DATADOG_SITE` in its `env-vars` block with a default of `datadoghq.com` and references it from `mcp.url` as `${DATADOG_SITE}`, so non-US1 operators (US3, US5, EU, AP1, AP2, GovCloud) set `DATADOG_SITE` in their Junior deployment env to their site host (e.g. `us5.datadoghq.com`, `datadoghq.eu`, `ddog-gov.com`). Users hitting auth failures against the wrong regional endpoint should have the operator confirm `DATADOG_SITE` is set correctly.
- If the user's Datadog account lives on a different site than the deployment is configured for, advise the operator to update the `DATADOG_SITE` environment variable. Do not try to work around this silently inside a turn.

## Read-only scope

- This skill intentionally exposes only read-oriented Datadog tools.
- If the user asks to create a notebook, edit a monitor, mute an alert, or resolve an incident, stop and tell them those actions are not in scope. Do not attempt to approximate the mutation from read tools.
