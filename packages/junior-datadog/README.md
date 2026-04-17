# @sentry/junior-datadog

`@sentry/junior-datadog` adds read-only Datadog telemetry workflows to Junior through Datadog's hosted MCP server.

Install it alongside `@sentry/junior`:

```bash
pnpm add @sentry/junior @sentry/junior-datadog
```

Then register the plugin package in `juniorNitro(...)`:

```ts title="nitro.config.ts"
juniorNitro({
  pluginPackages: ["@sentry/junior-datadog"],
});
```

This package does not use `DD_API_KEY`, `DD_APP_KEY`, or a shared workspace integration. Each user connects their own Datadog account the first time Junior calls a Datadog MCP tool. Junior sends the OAuth link privately and resumes the thread automatically after the user authorizes.

Junior intentionally keeps this package read-only by limiting the MCP tool surface to search, fetch, and log analytics tools. The plugin does not expose notebook writes, monitor edits, or other mutating Datadog tools.

## Datadog site

The packaged manifest points at the US1 endpoint (`mcp.datadoghq.com`) and enables the `core`, `apm`, and `error-tracking` toolsets. Teams on other Datadog sites (US3, US5, EU, AP1, AP2) can copy this plugin into `app/plugins/datadog/` and override the `mcp.url` to their regional endpoint.

## Optional channel defaults

If a Slack channel usually investigates the same Datadog environment or service, store that as a conversation-scoped default:

```bash
jr-rpc config set datadog.env prod
jr-rpc config set datadog.service checkout
```

These defaults are optional fallbacks. If a user names a different env or service in a request, Junior should follow the explicit request instead.

## Auth model

- Datadog MCP requires user-based OAuth (OAuth 2.1 + PKCE) and does not accept shared bearer tokens here.
- This package is not suitable for fully headless or unattended automation.
- Users can disconnect from Junior App Home with `Unlink`, or by asking Junior to disconnect Datadog.

Full setup guide: https://junior.sentry.dev/extend/datadog-plugin/
