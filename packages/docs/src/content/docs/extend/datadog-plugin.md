---
title: Datadog Plugin
description: Configure Datadog's Pup CLI for read-only observability workflows (logs, metrics, traces, monitors, incidents, dashboards).
type: tutorial
prerequisites:
  - /extend/
related:
  - /concepts/credentials-and-oauth/
  - /operate/security-hardening/
---

The Datadog plugin installs Datadog's Pup CLI so Slack users can query Datadog telemetry from Junior: logs, metrics, APM traces/spans, monitors, incidents, dashboards, hosts, services, and RUM.

Junior intentionally keeps this plugin read-only. The packaged manifest sets Pup read-only mode and the bundled skill instructs Junior to run `pup --read-only --agent` commands. It is for search, fetch, and analytics workflows, not Datadog mutations.

The packaged plugin defaults to Datadog's US1 endpoint. A Junior deployment points at one Datadog org/site, so the site is a deployment-level setting, not a per-user or per-channel one. Operators on other sites select their site with the `DATADOG_SITE` env var; see [Non-US1 sites](#non-us1-sites).

## Install

Install the plugin package alongside `@sentry/junior`:

```bash
pnpm add @sentry/junior @sentry/junior-datadog
```

## Runtime setup

Add the package name to the plugin set exported from `plugins.ts`:

```ts title="plugins.ts"
import { defineJuniorPlugins } from "@sentry/junior";

export const plugins = defineJuniorPlugins(["@sentry/junior-datadog"]);
```

## Config

Set conversation config with `jr-rpc config set`, or define the same keys for every conversation with `createApp({ configDefaults })`. Set deployment variables in the Junior environment, then redeploy. Explicit values in a request always win over conversation defaults.

<details class="plugin-config">
<summary><code>datadog.env</code></summary>

Default Datadog environment filter when a request does not name one.

- **Define:** `jr-rpc config set datadog.env <environment>`
- **Install-wide default:** `configDefaults["datadog.env"]`
- **Required:** No
- **Environment override:** None

</details>

<details class="plugin-config">
<summary><code>datadog.service</code></summary>

Default Datadog service filter when a request does not name one.

- **Define:** `jr-rpc config set datadog.service <service>`
- **Install-wide default:** `configDefaults["datadog.service"]`
- **Required:** No
- **Environment override:** None

</details>

<details class="plugin-config">
<summary><code>DATADOG_API_KEY</code></summary>

Datadog API key used for read-only telemetry requests.

- **Define:** Set `DATADOG_API_KEY` in the deployment environment
- **Required:** Yes
- **Environment override:** `DATADOG_API_KEY`

</details>

<details class="plugin-config">
<summary><code>DATADOG_APP_KEY</code></summary>

Datadog application key used for read-only telemetry requests. Grant the smallest role and scopes users need.

- **Define:** Set `DATADOG_APP_KEY` in the deployment environment
- **Required:** Yes
- **Environment override:** `DATADOG_APP_KEY`

</details>

<details class="plugin-config">
<summary><code>DATADOG_SITE</code></summary>

Datadog site hostname for the org connected to this Junior deployment.

- **Define:** Set `DATADOG_SITE` in the deployment environment
- **Default:** `datadoghq.com` (US1)
- **Required:** No
- **Environment override:** `DATADOG_SITE`

The plugin maps this value to Pup's `DD_SITE`; see [Non-US1 sites](#non-us1-sites) for standard values.

</details>

## Auth model

- The plugin uses deployment-level Datadog API and application keys, not per-user OAuth.
- Junior keeps the real `DATADOG_API_KEY` and `DATADOG_APP_KEY` values host-side.
- Matching Datadog API requests from Pup receive host-managed `DD-API-KEY` and `DD-APPLICATION-KEY` headers.
- The sandbox receives only non-secret placeholder env values so Pup can perform its normal credential checks before making requests.
- Users do not connect or disconnect individual Datadog accounts from Junior App Home for this plugin.

## What users can do

- Search raw logs and aggregate log counts/top-N buckets.
- Search spans and aggregate latency/error buckets.
- Query metrics, find metric names, and inspect metric metadata/tag dimensions.
- Inspect monitors and incidents to answer "is this alerting?" and "what is INC-123?".
- List APM services and service dependencies.
- List hosts and inspect host details.
- Fetch dashboards and notebooks by ID.
- Query RUM events, sessions, and frontend aggregates.

## Non-US1 sites

Datadog customers are region-pinned. The packaged manifest declares `DATADOG_SITE` with a default of `datadoghq.com` (US1), then exposes it to Pup as `DD_SITE`:

```yaml
env-vars:
  DATADOG_SITE:
    default: datadoghq.com

command-env:
  DD_SITE: ${DATADOG_SITE}
```

Set `DATADOG_SITE` in your Junior deployment env (for example Vercel project settings) to the hostname portion of your Datadog site:

| Datadog site | `DATADOG_SITE` value                 |
| ------------ | ------------------------------------ |
| US1          | _unset_ (default) or `datadoghq.com` |
| US3          | `us3.datadoghq.com`                  |
| US5          | `us5.datadoghq.com`                  |
| EU           | `datadoghq.eu`                       |
| AP1          | `ap1.datadoghq.com`                  |
| AP2          | `ap2.datadoghq.com`                  |
| GovCloud     | `ddog-gov.com`                       |

The packaged domain declarations cover those standard Datadog sites. Custom or staging Datadog domains require a manifest change before Junior can inject headers for that host.

## Verify

Confirm Junior can query Datadog successfully:

1. Ask Junior a Datadog question in a channel, for example: `What monitors are alerting for service checkout in prod right now?`
2. Confirm the thread returns monitor state, incident/log/trace detail, or a clear "no results" answer.
3. Confirm the answer includes the query/time window used and a Datadog deep link when one is available.

## Failure modes

- `DATADOG_API_KEY` or `DATADOG_APP_KEY` missing: add both env vars to the Junior deployment and redeploy.
- `401 Unauthorized`: the API key or application key is invalid, revoked, or not being injected for the selected Datadog site.
- `403 Forbidden` or `permission denied`: the Datadog application key cannot read the requested resource. Verify its scopes/role.
- `429 Too Many Requests`: Datadog is throttling. Retry the request later or narrow the query.
- Empty query results: env/service tag values are case-sensitive. Confirm the tag values exist and try a wider time window before widening the filter.
- Partial span/trace output: Pup exposes span search; a trace ID search may not prove that every span in the trace was returned.
- Mutation requests (create notebook, edit monitor, submit metric, resolve incident): the plugin is read-only and the skill will decline these.
- Wrong Datadog site: set `DATADOG_SITE` in the deployment env (see [Non-US1 sites](#non-us1-sites)).

## Next step

Review [Credentials & OAuth](/concepts/credentials-and-oauth/) and [Security Hardening](/operate/security-hardening/).
