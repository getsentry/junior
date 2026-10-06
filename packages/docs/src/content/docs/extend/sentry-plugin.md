---
title: Sentry Plugin
description: Configure Sentry OAuth, org read access, and issue webhooks.
type: tutorial
prerequisites:
  - /extend/
related:
  - /concepts/credentials-and-oauth/
  - /concepts/watches/
  - /operate/security-hardening/
---

Use the Sentry plugin to investigate issues with a user's Sentry account and respond to new issues through watches and event automations.

Junior stores each user's OAuth grant and uses it only for that user's requests. Optional org read access lets Junior read Sentry data when no user can connect, such as in scheduled tasks and event automations. Webhooks use a separate internal integration.

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

### Conversation defaults

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

### Environment variables

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
<summary><code>SENTRY_READ_ORG</code></summary>

Organization slug that `SENTRY_READ_TOKEN` can read.

- **Define:** Set `SENTRY_READ_ORG` in the deployment environment
- **Required:** Yes for org read access; otherwise no
- **Environment override:** `SENTRY_READ_ORG`

</details>

<details class="plugin-config">
<summary><code>SENTRY_READ_TOKEN</code></summary>

Internal integration token with read-only scopes. Junior uses it for read requests to `SENTRY_READ_ORG`.

- **Define:** Set `SENTRY_READ_TOKEN` in the deployment environment
- **Required:** Yes for org read access; otherwise no
- **Environment override:** `SENTRY_READ_TOKEN`

</details>

<details class="plugin-config">
<summary><code>SENTRY_WEBHOOK_ORG</code></summary>

Organization slug allowed to send issue webhooks.

- **Define:** Set `SENTRY_WEBHOOK_ORG` in the deployment environment
- **Required:** Yes for events; otherwise no
- **Environment override:** `SENTRY_WEBHOOK_ORG`

</details>

<details class="plugin-config">
<summary><code>SENTRY_WEBHOOK_SECRET</code></summary>

Internal integration client secret used to verify issue webhooks.

- **Define:** Set `SENTRY_WEBHOOK_SECRET` in the deployment environment
- **Required:** Yes for events; otherwise no
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

## Set up org read access

Without org read access, every Sentry request needs the requesting user's OAuth token. Turns that cannot send an authorization link then fail. Examples are scheduled tasks, event automations, and messages from other bots.

Create a **Sentry internal integration** for org read access. Use a separate integration from the webhook integration so you can revoke it on its own.

1. Create an internal integration in the organization.
2. Grant read-only permissions for **Project**, **Issue & Event**, **Organization**, and **Release**. Add **Team** and **Member** read only if you need them.
3. Create a token for the integration.
4. Set `SENTRY_READ_TOKEN` to the token and `SENTRY_READ_ORG` to the organization slug.
5. Redeploy Junior.

Junior uses the token for `GET`, `HEAD`, and `OPTIONS` requests to the Sentry API in `SENTRY_READ_ORG`. Requests that do not name an organization, such as `/api/0/issues/{id}/`, also use the token, because Sentry limits it to its own organization. All other requests use the requesting user's OAuth token. This includes writes, `POST` queries, `/api/0/users/` requests, and requests to other organizations.

Anyone who can talk to Junior can read every project the token can read. Sentry audit logs show the integration, not the Slack user.

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

## Watches

Set `SENTRY_WEBHOOK_ORG` and `SENTRY_WEBHOOK_SECRET` to enable watches. See [Watches](/concepts/watches/) for the difference between temporary watches and durable event automations.

### `issue`

Subscribe to one issue with `org/project#issueId`.

<details class="event">
<summary><code>issue.created</code></summary>

The issue was created.

</details>

### `project`

Subscribe to all new issues in a project with `org/project`.

<details class="event">
<summary><code>issue.created</code></summary>

An issue was created in the project.

</details>

Create the watch or event automation before the issue arrives. Junior does not replay earlier webhooks.

## Verify

**OAuth:** Connect Sentry from Slack, then query an issue or organization.

**Org read access:** Ask Junior to read an issue from a scheduled task, then make sure it does not ask you to connect Sentry.

**Webhooks:** Subscribe to a project, then create a test issue in that project.

## Security

- Junior stores user tokens and does not include them in model input.
- The org read token is used only for read requests. Writes always need the requesting user's OAuth token.
- Webhooks use the internal integration client secret, not user OAuth.
- Missing or stale user authorization starts a private reconnect flow.

## Failure modes

- **OAuth callback fails:** Set the app's redirect URL to exactly `<base-url>/api/oauth/callback/sentry`.
- **Sentry returns `401`:** Reconnect Sentry to replace the stale or revoked token.
- **Sentry reports a missing scope:** Reconnect Sentry to grant the current scopes.
- **Sentry returns `403`:** Connect an account with access to the requested organization and project. With org read access, also check the integration's read permissions.
- **A scheduled task cannot read Sentry:** Set `SENTRY_READ_TOKEN` and `SENTRY_READ_ORG`, and confirm the request targets `SENTRY_READ_ORG`.
- **Webhooks are ignored:** Check `SENTRY_WEBHOOK_ORG` and `SENTRY_WEBHOOK_SECRET`, then confirm a matching watch or event automation exists.
- **Authorization links use the wrong host:** Set `JUNIOR_BASE_URL` to Junior's public URL.

## Next step

Review [Watches](/concepts/watches/) and [Security Hardening](/operate/security-hardening/).
