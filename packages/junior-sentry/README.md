# @sentry/junior-sentry

Sentry investigations and explicitly requested project, team, and alert changes (per-user OAuth plus optional org read access) and signed issue webhooks (internal integration) for Junior.

```bash
pnpm add @sentry/junior @sentry/junior-sentry
```

```ts
import { defineJuniorPlugins } from "@sentry/junior";
import { sentryPlugin } from "@sentry/junior-sentry";

export const plugins = defineJuniorPlugins([sentryPlugin()]);
```

## User OAuth

Set `SENTRY_CLIENT_ID` and `SENTRY_CLIENT_SECRET` from a Sentry OAuth app whose redirect is:

```text
<base-url>/api/oauth/callback/sentry
```

Junior injects the user's token as `SENTRY_AUTH_TOKEN` for skill/CLI commands. Reconnect after scope changes.

Verified CLI surface (check live `sentry --help` before blocking):

- `sentry issue list|events|explain|plan|view`
- `sentry org list|view`
- `sentry project create|list|view`, `sentry team list`, `sentry dsn list`
- `sentry log list|view`
- `sentry trace list|view|logs`
- `sentry alert metrics list|view|create|edit|delete`
- `sentry api <endpoint>` fallback, with `sentry schema` for endpoint lookup

## Org read access

Set `SENTRY_READ_TOKEN` to a read-only internal integration token. Junior then uses it for Sentry API reads (`GET`, `HEAD`, `OPTIONS`), including Explore queries, scheduled tasks, and event automations. Writes and `/api/0/users/` requests still use the requesting user's OAuth token.

## Issue and metric alert webhooks

Use a **Sentry internal integration** (not a public app install flow):

1. Subscribe to the **issue** webhook resource.
2. Point it at `https://<junior-host>/api/webhooks/sentry`.
3. Set the integration client secret as `SENTRY_WEBHOOK_SECRET`, then redeploy.

For metric alerts, also enable **Alert Rule Action** on the integration and add it as a `sentry_app` trigger action on each alert. Sentry sends metric alerts only to alert actions.

Junior verifies `Sentry-Hook-Signature`, reads the org slug from the signed payload, and publishes:

- `issue.created` for `org/project#issueId` and `org/project`.
- `metric_alert.critical`, `metric_alert.warning`, and `metric_alert.resolved` for `metric-alert:org/alertRuleId` and for `org/project` of each project on the alert rule.

Create watches/event automations before the webhook arrives; unmatched deliveries are not replayed.

Full guide: https://junior.sentry.dev/extend/sentry-plugin/
