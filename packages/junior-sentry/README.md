# @sentry/junior-sentry

Sentry investigations with user OAuth or a read-only service connection, and signed issue webhooks for Junior.

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

This is the default mode. Junior applies the user's token to Sentry requests on the host. The Sandbox receives only a non-secret `SENTRY_AUTH_TOKEN` placeholder. Reconnect after scope changes.

Verified CLI surface (check live `sentry --help` before blocking):

- `sentry issue list|events|explain|plan|view`
- `sentry org list|view`
- `sentry log list|view`
- `sentry trace list|view|logs`
- `sentry alert metrics list|view|create|edit|delete`
- `sentry api <endpoint>` fallback

## Unattended investigations

Slack bot messages cannot start interactive OAuth. They also cannot use a token from a person mentioned in the message or from an earlier thread participant. A skill's task approval does not change this credential boundary.

For deployment triage that must run without a person, select service auth:

```ts
export const plugins = defineJuniorPlugins([sentryPlugin({ auth: "service" })]);
```

Set `SENTRY_SERVICE_TOKEN` in the **host deployment environment**, then redeploy. Use a Sentry internal integration token with read access to the organizations and projects needed for triage. Do not use a release-upload token or put the token in app config, a skill, or the Sandbox. The webhook secret is not an API token.

This is an install-wide choice, not a skill-triggered permission grant. All actors using this installation share the service token's read access, including human requests. Choose this mode only when that shared access is intended. Sentry enforces the token's resource permissions. The plugin permits only `GET` and `HEAD` under `/api/0/` on its three declared Sentry API hosts. It blocks writes, including alert changes and Seer actions that use `POST`.

The host issues five-minute leases and applies the token through the existing egress proxy. The Sandbox receives only the CLI placeholder. Missing or rejected service credentials need operator repair; they do not start user OAuth or fall back to another user's token. Normal runtime action review remains in place.

This mode replaces user OAuth for the installation. To restore user-scoped access and explicitly requested writes, use `sentryPlugin()` and redeploy. No stored user connections are deleted. Installing the package alone does not enable service access or supply a token.

## Issue webhooks

Use a **Sentry internal integration** (not a public app install flow):

1. Subscribe to the **issue** webhook resource.
2. Point it at `https://<junior-host>/api/webhooks/sentry`.
3. Set the org slug as `SENTRY_WEBHOOK_ORG` and the integration client secret as `SENTRY_WEBHOOK_SECRET`, then redeploy.

Junior verifies `Sentry-Hook-Signature`, rejects payloads outside `SENTRY_WEBHOOK_ORG`, and publishes `issue.created` for `org/project#issueId` and `org/project`. Create watches/event automations before the issue arrives; unmatched deliveries are not replayed.

Full guide: https://junior.sentry.dev/extend/sentry-plugin/
