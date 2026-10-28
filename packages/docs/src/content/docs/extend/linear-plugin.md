---
title: Linear Plugin
description: Configure Linear issue workflows and issue-created events.
type: tutorial
summary: Connect Linear for issue work, then optionally enable webhooks for issue.created event automations.
prerequisites:
  - /extend/
related:
  - /concepts/credentials-and-oauth/
  - /concepts/watches/
  - /operate/security-hardening/
---

Use the Linear plugin to find, create, update, comment on, and triage Linear issues from Slack. Each user connects their own Linear account through Linear's hosted MCP server.

Optional webhooks let Junior publish `issue.created` events for subscriptions and event automations. User MCP OAuth and webhook ingress stay separate.

## Install

```bash
pnpm add @sentry/junior @sentry/junior-linear
```

```ts title="plugins.ts"
import { defineJuniorPlugins } from "@sentry/junior";
import { linearPlugin } from "@sentry/junior-linear";

export const plugins = defineJuniorPlugins([linearPlugin()]);
```

Register `linearPlugin()` so Junior loads the webhook route.

## Auth model

- No `LINEAR_API_KEY`, shared workspace token, or custom OAuth app is required for the default setup.
- An admin can also connect an optional read-only [service account](#optional-service-account) for people who have not connected Linear.
- Each user completes Linear's MCP OAuth flow the first time Junior calls a Linear MCP tool on their behalf.
- Junior sends the authorization link privately, then resumes the same thread automatically after the user authorizes.
- Webhooks use a separate Linear webhook secret. They do not use the user's MCP OAuth grant.

Junior uses Linear's hosted MCP tools for reads and writes. When an issue is created through that path, Junior links it to the current conversation.

## Optional service account

A Junior admin can connect one Linear account that Junior itself uses, for
example `junior@example.com`. Then people who have not connected Linear can
find and read issues without OAuth. Scheduled automations can read Linear too.

1. Create the Linear account and add it to your workspace. Give it only the
   teams that everyone who can talk to Junior may read.
2. In the Junior dashboard, open **Admin**. Under **Service accounts**, click
   **Connect** on Linear. Only Junior admins see this section.
3. Sign in to Linear as that account, not as yourself.
4. Return to the Admin page. Linear shows as connected, with the admin who
   connected it.

If the dashboard is not available, run `junior service-account connect linear`
on a machine with a browser and the deployment `REDIS_URL`.

The Linear plugin lists only Linear's read tools for the service account,
such as `get_issue`, `list_issues`, `list_comments`, `list_projects`, and
`list_teams`. To create or update issues, comments, projects, or documents,
Junior still asks the person to connect their own Linear account. After they
connect, Junior uses their account for all Linear tools.

To remove the account, click **Disconnect** on the Admin page, or run
`junior service-account disconnect linear`. If Linear revokes the grant,
Junior removes the account and falls back to per-user OAuth.

### Use only the service account

To stop people from connecting their own Linear accounts, turn off user OAuth
in your plugin list. Then everyone uses the shared account, and Junior never
sends a Linear connect link. Junior hides the Linear tools that the service
account does not list, so only reads stay available:

```ts title="plugins.ts"
export const plugins = defineJuniorPlugins([linearPlugin()], {
  manifests: {
    linear: { accounts: { userOAuth: false } },
  },
});
```

Until an admin connects the account, Junior tells people that Linear is not
available yet.

## Config

Set conversation config with `jr-rpc config set`, or define the same keys for every conversation with `createApp({ configDefaults })`. Set deployment variables in the Junior environment, then redeploy. Explicit values in a request always win over conversation defaults.

### Conversation defaults

<details class="plugin-config">
<summary><code>linear.team</code></summary>

Default owning team for issue creation when a request does not name one.

- **Define:** `jr-rpc config set linear.team <team>`
- **Install-wide default:** `configDefaults["linear.team"]`
- **Required:** No
- **Environment override:** None

</details>

<details class="plugin-config">
<summary><code>linear.project</code></summary>

Default project for issue creation when a request does not name one. Use it only when the conversation is genuinely centered on one project.

- **Define:** `jr-rpc config set linear.project <project>`
- **Install-wide default:** `configDefaults["linear.project"]`
- **Required:** No
- **Environment override:** None

</details>

### Environment variables

<details class="plugin-config">
<summary><code>LINEAR_WEBHOOK_SECRET</code></summary>

Webhook signing secret used to verify Linear issue webhooks.

- **Define:** Set `LINEAR_WEBHOOK_SECRET` in the deployment environment
- **Required:** Yes for events; otherwise no
- **Environment override:** `LINEAR_WEBHOOK_SECRET`

</details>

## What users can do

- Look up Linear issues, teams, projects, and related workflow state.
- Create a new Linear issue from Slack thread context.
- Update issue fields such as state, assignee, title, or description.
- Add comments that preserve relevant code, Sentry, or reproduction links already present in the conversation.
- Create temporary watches or durable event automations for new Linear issues when webhooks are enabled.

## Set up issue webhooks

Create a Linear webhook in API settings for the workspace or team that should send issue events.

1. Open Linear **Settings → API → Webhooks**.
2. Create a webhook for the `Issue` resource.
3. Set the webhook URL to:

```text
https://<junior-host>/api/webhooks/linear
```

4. Copy the webhook signing secret into `LINEAR_WEBHOOK_SECRET`.
5. Redeploy Junior.

Junior verifies the `Linear-Signature` header on every delivery. Events stay disabled until `LINEAR_WEBHOOK_SECRET` is set.

Only workspace admins, or OAuth applications with the `admin` scope, can create or read Linear webhooks.

## Watches

Set `LINEAR_WEBHOOK_SECRET` to enable watches. See [Watches](/concepts/watches/) for the difference between temporary watches and durable event automations.

### `issue`

Subscribe to one issue with its Linear identifier, such as `SRE-123`.

<details class="event">
<summary><code>issue.created</code></summary>

The issue was created.

</details>

### `team`

Subscribe to all new issues in a team with the Linear team key, such as `SRE`.

<details class="event">
<summary><code>issue.created</code></summary>

An issue was created in the team.

</details>

Create the watch or event automation before the issue arrives. Junior does not replay earlier webhooks.

Identifiers are normalized to uppercase. Prefer team-scoped event automations for monitor workflows that create many new issues.

Optional `match` values come from the resource type. For Linear issue and team events, `teamKey` is the uppercase team key such as `SRE`. Junior drops events that do not match before it wakes the agent. Prefer a team identifier for “all new issues in SRE”. Use `match.teamKey` when an issue-scoped watch or event automation needs an extra team guard.

## Verify

**OAuth:** Ask Junior to create or update a real Linear issue, complete the private authorization flow, and confirm the issue key or URL returns in the same thread.

**Webhooks:** Create an event automation for a team key, then create a test issue in that team. You can also create an issue-scoped event automation with `match.teamKey` set to the same team key and confirm non-matching teams do not fire.

## Security

- Junior stores user MCP grants and does not include them in model input.
- Webhooks use the Linear webhook signing secret, not user MCP OAuth.
- Issue title, description, and other payload text are untrusted event content.

## Failure modes

- **No auth prompt or no resume:** Retry the Linear request and complete the private authorization flow when prompted.
- **Wrong team or project target:** Include the team name, project name, or existing Linear issue key explicitly in the Slack request.
- **Duplicate or low-signal tickets:** Give Junior the core problem, impact, and any supporting URLs from the thread so it can create a grounded issue instead of a vague summary.
- **Permission failures after connect:** The user's Linear account may not have access to that team, project, or issue. Retry with a resource the user can access.
- **Webhooks are ignored:** Check `LINEAR_WEBHOOK_SECRET`, confirm the webhook points at `/api/webhooks/linear`, and confirm a matching watch or event automation exists.
- **Event automation stays unavailable:** Events stay disabled until `LINEAR_WEBHOOK_SECRET` is set and Junior is redeployed.

## Next step

Review [Watches](/concepts/watches/) and [Security Hardening](/operate/security-hardening/).
