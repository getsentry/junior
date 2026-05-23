# @sentry/junior-datadog

`@sentry/junior-datadog` adds read-only Datadog telemetry workflows to Junior through Datadog's Pup CLI.

Install it alongside `@sentry/junior`:

```bash
pnpm add @sentry/junior @sentry/junior-datadog
```

Then register the plugin package in `juniorNitro(...)`:

```ts title="nitro.config.ts"
juniorNitro({
  plugins: {
    packages: ["@sentry/junior-datadog"],
  },
});
```

Set Datadog credentials in the Junior deployment environment:

```bash
DATADOG_API_KEY=...
DATADOG_APP_KEY=...
DATADOG_SITE=datadoghq.com # optional; defaults to US1
```

Use `DATADOG_API_KEY`, `DATADOG_APP_KEY`, and `DATADOG_SITE` in the Junior deployment environment. The plugin maps those host-side `DATADOG_*` values to Datadog API headers and Pup's sandbox `DD_*` env values.

The real API and application keys stay host-side. Junior injects them into matching Datadog API requests as `DD-API-KEY` and `DD-APPLICATION-KEY` headers; the sandbox only receives non-secret placeholder values so Pup can perform its normal auth checks.

Junior keeps this package read-only by setting Pup's read-only mode and by guiding the skill to use `pup --read-only --agent` commands. The plugin is intended for searches, fetches, and analytics across logs, metrics, traces/spans, monitors, incidents, dashboards, hosts, services, and RUM.

## Datadog site

The packaged manifest defaults to the US1 API endpoint. Teams on other Datadog sites set `DATADOG_SITE` in their Junior deployment env to their site host. Setting deployment `DD_SITE` alone has no effect.

| Datadog site | `DATADOG_SITE` value                 |
| ------------ | ------------------------------------ |
| US1          | _unset_ (default) or `datadoghq.com` |
| US3          | `us3.datadoghq.com`                  |
| US5          | `us5.datadoghq.com`                  |
| EU           | `datadoghq.eu`                       |
| AP1          | `ap1.datadoghq.com`                  |
| AP2          | `ap2.datadoghq.com`                  |
| GovCloud     | `ddog-gov.com`                       |

The packaged API allowlist covers those standard Datadog sites. Custom or staging Datadog domains require a manifest change so the sandbox network header transform is allowed for that host.

## Optional channel defaults

If a Slack channel usually investigates the same Datadog environment or service, store that as a conversation-scoped default:

```bash
jr-rpc config set datadog.env prod
jr-rpc config set datadog.service checkout
```

These defaults are optional fallbacks. If a user names a different env or service in a request, Junior should follow the explicit request instead.

## Auth model

- This package uses deployment-level Datadog API and application keys, not per-user OAuth.
- Use a Datadog application key with the smallest read scopes/role that covers the telemetry users need.
- Real key values never enter the sandbox env, files, or command arguments.

Full setup guide: https://junior.sentry.dev/extend/datadog-plugin/
