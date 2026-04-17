---
title: Datadog Plugin
description: Configure the hosted Datadog MCP server for read-only observability workflows (logs, metrics, traces, monitors, incidents, dashboards).
type: tutorial
prerequisites:
  - /extend/
related:
  - /concepts/credentials-and-oauth/
  - /operate/security-hardening/
---

The Datadog plugin uses Datadog's hosted MCP server so Slack users can query their own Datadog account context — logs, metrics, APM traces, monitors, incidents, dashboards, and RUM — without sharing a workspace API key.

Junior intentionally keeps this plugin read-only. The packaged manifest exposes only search-, fetch-, and analytics-oriented Datadog MCP tools. It does not expose notebook, monitor, SLO, or incident mutations, even though Datadog's MCP server supports some of them.

The packaged plugin defaults to Datadog's US1 endpoint and enables the `core`, `apm`, and `error-tracking` toolsets. A Junior deployment points at exactly one Datadog org (which is pinned to exactly one region), so the site is a deployment-level setting, not a per-user or per-channel one. Operators on other sites select their site with the `DATADOG_SITE` env var — see [Non-US1 sites](#non-us1-sites) below.

## Install

Install the plugin package alongside `@sentry/junior`:

```bash
pnpm add @sentry/junior @sentry/junior-datadog
```

## Runtime setup

List the plugin in `juniorNitro({ pluginPackages: [...] })`:

```ts title="nitro.config.ts"
juniorNitro({
  pluginPackages: ["@sentry/junior-datadog"],
});
```

## Optional channel defaults

If a Slack channel usually investigates the same Datadog environment or service, store that as a conversation-scoped default:

```bash
jr-rpc config set datadog.env prod
jr-rpc config set datadog.service checkout
```

These defaults are optional fallbacks. If a user names a different env or service in a request, Junior follows the explicit request instead.

## Auth model

- No `DD_API_KEY`, `DD_APP_KEY`, or shared workspace integration secret is required.
- Each user completes OAuth the first time Junior calls a Datadog MCP tool on their behalf.
- Junior sends the authorization link privately, then resumes the same thread automatically after the user authorizes.
- Datadog MCP requires user-based OAuth (OAuth 2.1 + PKCE) and does not accept shared bearer tokens here, so this plugin is not suitable for fully headless automation.

## What users can do

- Search logs, events, RUM sessions, spans, and hosts scoped by env/service/time window.
- Run SQL-style log analytics (counts, top-N, group-bys) with `analyze_datadog_logs`.
- Inspect monitors and incidents to answer "is this alerting?" and "what is INC-123?".
- Fetch a trace or a notebook by ID.
- List services and their upstream/downstream dependencies from the Software Catalog.
- Query a metric by name and inspect its available tag dimensions before querying.
- Disconnect their account later from Junior App Home with `Unlink`.

## Non-US1 sites

Datadog customers are region-pinned. The packaged manifest declares `DATADOG_SITE` in its `env-vars` block with a default of `datadoghq.com` (US1) and references it from `mcp.url`:

```yaml
env-vars:
  DATADOG_SITE:
    default: datadoghq.com

mcp:
  url: https://mcp.${DATADOG_SITE}/api/unstable/mcp-server/mcp?toolsets=core,apm,error-tracking
```

Set `DATADOG_SITE` in your Junior deployment env (e.g. Vercel project settings) to the hostname portion of your Datadog site:

| Datadog site | `DATADOG_SITE` value                 |
| ------------ | ------------------------------------ |
| US1          | _unset_ (default) or `datadoghq.com` |
| US3          | `us3.datadoghq.com`                  |
| US5          | `us5.datadoghq.com`                  |
| EU           | `datadoghq.eu`                       |
| AP1          | `ap1.datadoghq.com`                  |
| AP2          | `ap2.datadoghq.com`                  |
| GovCloud     | `ddog-gov.com`                       |

No code changes, no app-local plugin copy, no rebuild. Junior reads the variable at plugin-discovery time and hits the correct regional MCP endpoint.

## Verify

Confirm a real user can connect and query successfully:

1. Ask Junior a Datadog question in a channel, for example: `What monitors are alerting for service checkout in prod right now?`
2. Complete the private OAuth flow when Junior prompts for it.
3. Confirm the thread resumes automatically with the monitor state (or incident / log / trace detail) and a Datadog deep link.
4. Open Junior App Home and confirm Datadog appears under `Connected accounts`.

## Failure modes

- No auth prompt or no resume: the user still needs to complete the OAuth flow. Retry the request and finish the private authorization flow when prompted.
- `401` mid-session: the Datadog OAuth token expired or was revoked; the runtime will resurface the authorization flow. Finish it and retry.
- `403 Forbidden` or `permission denied`: the user's Datadog role cannot read the requested resource. Verify their Datadog team/role assignments.
- `429 Too Many Requests`: the Datadog MCP endpoint is throttling. Junior retries once. If it still fails, the user should retry again shortly.
- Empty query results: env/service tag values are case-sensitive. Confirm the tag values exist and try a wider time window before widening the filter.
- Truncated trace response: very large traces are reported as truncated; the displayed spans are not the full trace.
- Mutation requests (create notebook, edit monitor, resolve incident): the plugin intentionally does not expose write tools. The skill will decline these.
- Wrong Datadog site: the packaged manifest defaults to US1. Operators on other sites must set `DATADOG_SITE` in the deployment env (see [Non-US1 sites](#non-us1-sites)).

## Next step

Review [Credentials & OAuth](/concepts/credentials-and-oauth/) and [Security Hardening](/operate/security-hardening/).
