# @sentry/junior-sentry

Sentry investigations (per-user OAuth) and signed issue webhooks (internal integration) for Junior.

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
- `sentry log list|view`
- `sentry trace list|view|logs`
- `sentry alert metrics list|view|create|edit|delete`
- `sentry api <endpoint>` fallback

## Issue webhooks

Use a **Sentry internal integration** (not a public app install flow):

1. Subscribe to the **issue** webhook resource.
2. Point it at `https://<junior-host>/api/webhooks/sentry`.
3. Set the org slug as `SENTRY_WEBHOOK_ORG` and the integration client secret as `SENTRY_WEBHOOK_SECRET`, then redeploy.

Junior verifies `Sentry-Hook-Signature`, rejects payloads outside `SENTRY_WEBHOOK_ORG`, and publishes `issue.created` for `org/project#issueId` and `org/project`. Create watches/event tasks before the issue arrives; unmatched deliveries are not replayed.

Full guide: https://junior.sentry.dev/extend/sentry-plugin/
