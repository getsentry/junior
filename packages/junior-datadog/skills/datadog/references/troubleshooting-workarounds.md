# Troubleshooting and Workarounds

Use this reference when Pup commands fail or return unexpected results.

## Permission and scope errors

- A `403 Forbidden` or `permission denied` response means the configured Datadog API/application keys cannot read that resource: metrics, APM, incidents, RUM, and so on.
- Stop and tell the user the current Datadog integration could not access the requested data. Suggest the operator verify the Datadog application key scopes/role.
- Do not guess specific missing permission names unless Datadog explicitly named one in the error.
- Do not loop retrying a 403.

## Authentication errors

- A `401 Unauthorized`, `missing API key`, or `missing application key` error usually means `DATADOG_API_KEY` or `DATADOG_APP_KEY` is missing from the Junior deployment env, or the key was revoked.
- Pup receives placeholder env values in the sandbox so it will make HTTP requests; the host injects the real `DD-API-KEY` and `DD-APPLICATION-KEY` headers for Datadog API domains.
- Do not ask the user to paste keys into Slack or the sandbox. Tell the operator to fix the deployment env and retry.

## Rate limits

- Datadog API endpoints can return `429 Too Many Requests`.
- Retry the same query once after a short wait.
- If it fails again, report the throttle and stop. Do not fall back to larger scans that will throttle harder.

## Query returned no results

- Double-check that `env:` and `service:` match real values. Datadog tag values are case-sensitive.
- Widen the time window before widening the filter. Many "no results" cases are just too narrow a window.
- If searching logs or RUM with `@<field>:value`, confirm the field exists as a facet.
- If an expected monitor or incident is missing, the application key may not have access to that team/resource.

## Too many results / large payloads

- Prefer `pup --read-only --agent logs aggregate` or `traces aggregate` with `--group-by` + `--limit` over paging raw events.
- For span/trace responses that look partial, say so in the reply. Do not pretend the shown spans are complete.
- Quote only the minimum log / span / metric content needed as evidence. Link to Datadog for the rest.

## Multiple Datadog sites

- The packaged plugin defaults to US1 (`datadoghq.com`) and sets Pup's `DD_SITE` from the manifest `DATADOG_SITE` env var.
- Non-US1 operators set `DATADOG_SITE` in their Junior deployment env to their site host, for example `us5.datadoghq.com`, `datadoghq.eu`, or `ddog-gov.com`.
- Setting deployment `DD_SITE` alone has no effect; the plugin owns Pup's sandbox `DD_SITE` through `DATADOG_SITE`.
- The packaged plugin allows the standard Datadog API hosts for US1, US3, US5, EU, AP1, AP2, and GovCloud. A custom or staging Datadog domain needs a manifest change so the API domain allowlist matches.
- If the user's Datadog account lives on a different site than the deployment is configured for, advise the operator to update `DATADOG_SITE`. Do not try to work around this silently inside a turn.

## Read-only scope

- This skill intentionally uses only read-oriented Pup commands.
- If the user asks to create a notebook, edit a monitor, mute an alert, submit a metric, or resolve an incident, stop and tell them those actions are not in scope.
