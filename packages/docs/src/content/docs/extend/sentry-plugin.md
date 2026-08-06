---
title: Sentry Plugin
description: Configure Sentry OAuth and issue webhooks.
type: tutorial
prerequisites:
  - /extend/
related:
  - /concepts/credentials-and-oauth/
  - /concepts/resource-subscriptions/
  - /operate/security-hardening/
---

Use the Sentry plugin to investigate issues with a user's Sentry account and respond to new issues through resource subscriptions and event tasks.

Junior stores each user's OAuth grant and uses it only for that user's requests. Webhooks use a separate internal integration.

## Install

```bash
pnpm add @sentry/junior @sentry/junior-sentry
```

```ts title="plugins.ts"
import { defineJuniorPlugins } from "@sentry/junior";
import { sentryPlugin } from "@sentry/junior-sentry";

export const plugins = defineJuniorPlugins([sentryPlugin()]);
```

Register `sentryPlugin()` so Junior loads the webhook route.

## Config

Set conversation config with `jr-rpc config set`, or define the same keys for every conversation with `createApp({ configDefaults })`. Set deployment variables in the Junior environment, then redeploy. Explicit values in a request always win over conversation defaults.

<details class="plugin-config">
<summary><code>sentry.org</code></summary>

Default Sentry organization slug when a request does not name one.

- **Define:** `jr-rpc config set sentry.org <organization>`
- **Install-wide default:** `configDefaults["sentry.org"]`
- **Required:** No
- **Environment override:** None

</details>

<details class="plugin-config">
<summary><code>sentry.project</code></summary>

Default Sentry project slug when a request does not name one.

- **Define:** `jr-rpc config set sentry.project <project>`
- **Install-wide default:** `configDefaults["sentry.project"]`
- **Required:** No
- **Environment override:** None

</details>

<details class="plugin-config">
<summary><code>SENTRY_CLIENT_ID</code></summary>

OAuth client ID used when a user connects their Sentry account.

- **Define:** Set `SENTRY_CLIENT_ID` in the deployment environment
- **Required:** Yes for user OAuth
- **Environment override:** `SENTRY_CLIENT_ID`

</details>

<details class="plugin-config">
<summary><code>SENTRY_CLIENT_SECRET</code></summary>

OAuth client secret used when a user connects their Sentry account.

- **Define:** Set `SENTRY_CLIENT_SECRET` in the deployment environment
- **Required:** Yes for user OAuth
- **Environment override:** `SENTRY_CLIENT_SECRET`

</details>

<details class="plugin-config">
<summary><code>SENTRY_WEBHOOK_ORG</code></summary>

Organization slug allowed to send issue webhooks.

- **Define:** Set `SENTRY_WEBHOOK_ORG` in the deployment environment
- **Required:** Yes for resource events; otherwise no
- **Environment override:** `SENTRY_WEBHOOK_ORG`

</details>

<details class="plugin-config">
<summary><code>SENTRY_WEBHOOK_SECRET</code></summary>

Internal integration client secret used to verify issue webhooks.

- **Define:** Set `SENTRY_WEBHOOK_SECRET` in the deployment environment
- **Required:** Yes for resource events; otherwise no
- **Environment override:** `SENTRY_WEBHOOK_SECRET`

</details>

## Set up user OAuth

Create a Sentry OAuth app with this redirect URL:

```text
<base-url>/api/oauth/callback/sentry
```

Set `SENTRY_CLIENT_ID` and `SENTRY_CLIENT_SECRET` to the app's credentials. Junior requests these scopes:

`alerts:write event:write member:read org:read project:releases project:write team:write`

Reconnect after scope changes. Existing grants do not pick up new scopes automatically.

## Set up issue webhooks

Create a **Sentry internal integration** in the organization that should send issue webhooks. A public Sentry app is not required.

1. Create an internal integration.
2. Enable the **issue** webhook resource.
3. Set the webhook URL to:

```text
https://<junior-host>/api/webhooks/sentry
```

4. Set `SENTRY_WEBHOOK_ORG` to the organization slug.
5. Set `SENTRY_WEBHOOK_SECRET` to the integration's client secret.
6. Redeploy Junior.

Junior verifies each webhook signature and accepts webhooks only from the configured organization.

## Resource subscriptions

Set `SENTRY_WEBHOOK_ORG` and `SENTRY_WEBHOOK_SECRET` to enable resource subscriptions. See [Resource Subscriptions](/concepts/resource-subscriptions/) for the difference between temporary subscriptions and durable event tasks.

### `issue`

Subscribe to one issue with `org/project#issueId`.

<details class="resource-event">
<summary><code>issue.created</code></summary>

The issue was created.

</details>

### `project`

Subscribe to all new issues in a project with `org/project`.

<details class="resource-event">
<summary><code>issue.created</code></summary>

An issue was created in the project.

</details>

Create the subscription or event task before the issue arrives. Junior does not replay earlier webhooks.

## Verify

**OAuth:** Connect Sentry from Slack, then query an issue or organization.

**Webhooks:** Subscribe to a project, then create a test issue in that project.

## Security

- Junior stores user tokens and does not include them in model input.
- Webhooks use the internal integration client secret, not user OAuth.
- Missing or stale user authorization starts a private reconnect flow.

## Failure modes

- **OAuth callback fails:** Set the app's redirect URL to exactly `<base-url>/api/oauth/callback/sentry`.
- **Sentry returns `401`:** Reconnect Sentry to replace the stale or revoked token.
- **Sentry reports a missing scope:** Reconnect Sentry to grant the current scopes.
- **Sentry returns `403`:** Connect an account with access to the requested organization and project.
- **Webhooks are ignored:** Check `SENTRY_WEBHOOK_ORG` and `SENTRY_WEBHOOK_SECRET`, then confirm a matching subscription or event task exists.
- **Authorization links use the wrong host:** Set `JUNIOR_BASE_URL` to Junior's public URL.

## Next step

Review [Resource Subscriptions](/concepts/resource-subscriptions/) and [Security Hardening](/operate/security-hardening/).
