---
title: Sentry Plugin
description: Configure per-user Sentry OAuth and internal-integration issue webhooks.
type: tutorial
prerequisites:
  - /extend/
related:
  - /concepts/credentials-and-oauth/
  - /operate/security-hardening/
---

The Sentry plugin does two things:

1. **Per-user OAuth** so Slack users can investigate Sentry with their own access.
2. **Internal-integration webhooks** so signed `issue.created` deliveries become Junior resource events for watches and event tasks.

Junior stores OAuth grants server-side and only injects them on that user's turn. Webhooks do not use per-user OAuth.

## Install

```bash
pnpm add @sentry/junior @sentry/junior-sentry
```

```ts title="plugins.ts"
import { defineJuniorPlugins } from "@sentry/junior";
import { sentryPlugin } from "@sentry/junior-sentry";

export const plugins = defineJuniorPlugins([sentryPlugin()]);
```

Register the factory. Package-name-only registration is not enough for webhook routes.

## Environment

| Variable                | Required | Purpose                                                |
| ----------------------- | -------- | ------------------------------------------------------ |
| `SENTRY_CLIENT_ID`      | Yes      | User OAuth client ID.                                  |
| `SENTRY_CLIENT_SECRET`  | Yes      | User OAuth client secret.                              |
| `SENTRY_WEBHOOK_ORG`    | No       | Org slug allowed to send issue webhooks.               |
| `SENTRY_WEBHOOK_SECRET` | No       | Internal integration client secret for issue webhooks. |

## User OAuth

Create a Sentry OAuth app with redirect URL:

```text
<base-url>/api/oauth/callback/sentry
```

Set `SENTRY_CLIENT_ID` / `SENTRY_CLIENT_SECRET` from that app. Junior requests:

`alerts:write event:write member:read org:read project:releases project:write team:write`

Reconnect after scope changes. Existing grants do not pick up new scopes automatically.

## Issue webhooks (internal integration)

Use a **Sentry internal integration** in the org that should notify Junior. Do not use a public/unpublished app install flow for this.

1. Create an internal integration.
2. Enable the **issue** webhook resource.
3. Set the webhook URL to:

```text
https://<junior-host>/api/webhooks/sentry
```

4. Set `SENTRY_WEBHOOK_ORG` to the org slug and copy the integration **client secret** into `SENTRY_WEBHOOK_SECRET`, then redeploy.

Junior verifies `Sentry-Hook-Signature`, then publishes `issue.created` for both:

- issue: `org/project#issueId`
- project: `org/project`

Create the watch or event task before the issue arrives. Unmatched deliveries are not replayed. One internal integration per Junior deployment is enough for a single Slack workspace; no install-mapping table is required for that shape.

## Verify

**OAuth:** connect Sentry from Slack, then run a real issue/org query.

**Webhooks:** with `SENTRY_WEBHOOK_ORG` and `SENTRY_WEBHOOK_SECRET` set, create a watch on a project or issue, then create a test issue in that project.

## Security

- User tokens stay host-side and are never printed to the model.
- Webhook auth is the internal integration client secret, independent of user OAuth.
- Missing or stale user auth triggers a private reconnect flow.

## Failure modes

- OAuth callback fails: redirect URL must exactly match `<base-url>/api/oauth/callback/sentry`.
- `401` after OAuth: reconnect; token is stale or revoked.
- Explicit missing/insufficient scope: reconnect to refresh the grant.
- Generic `403`: connected account cannot access the target org/project.
- Webhooks ignored: secret missing/wrong, or no matching watch/event task yet.
- Wrong host on auth links: set `JUNIOR_BASE_URL` to the public base URL.

## Next step

Review [Credentials & OAuth](/concepts/credentials-and-oauth/) and [Security Hardening](/operate/security-hardening/).
