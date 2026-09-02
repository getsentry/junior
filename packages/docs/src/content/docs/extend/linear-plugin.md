---
title: Linear Plugin
description: Configure Linear issue workflows and issue-created resource events.
type: tutorial
summary: Connect Linear for issue work, then optionally enable webhooks for issue.created event tasks.
prerequisites:
  - /extend/
related:
  - /concepts/credentials-and-oauth/
  - /concepts/resource-subscriptions/
  - /operate/security-hardening/
---

Use the Linear plugin to find, create, update, comment on, and triage Linear issues from Slack. A workspace admin installs one Linear OAuth app. Junior uses that app connection instead of asking each user to connect Linear.

Optional webhooks let Junior publish `issue.created` resource events for watches and event tasks. OAuth and webhooks use separate secrets.

## Install

```bash
pnpm add @sentry/junior @sentry/junior-linear
```

```ts title="plugins.ts"
import { defineJuniorPlugins } from "@sentry/junior";
import { linearPlugin } from "@sentry/junior-linear";

export const plugins = defineJuniorPlugins([linearPlugin()]);
```

Register `linearPlugin()` so Junior loads the Linear tools and webhook route.

## Connect Linear

1. Create an OAuth app in Linear.
2. Set its callback URL to `https://<junior-host>/api/oauth/callback/linear`.
3. Give it the `read,write` scopes.
4. Set `LINEAR_CLIENT_ID` and `LINEAR_CLIENT_SECRET` in Junior.
5. Ask Junior to use Linear. A workspace admin must complete the install once.

Junior requests `actor=app`. Linear records changes as made by the Junior app. The app can access every team available to it in the connected workspace. Junior uses the same app connection for requests from conversations, scheduled tasks, and event tasks.

When Junior creates an issue, it links the issue to the current conversation. If Linear rejects the refresh token, an admin must install the app again.

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
<summary><code>LINEAR_CLIENT_ID</code></summary>

Client ID for the Linear OAuth app.

- **Define:** Set `LINEAR_CLIENT_ID` in the deployment environment
- **Required:** Yes
- **Environment override:** `LINEAR_CLIENT_ID`

</details>

<details class="plugin-config">
<summary><code>LINEAR_CLIENT_SECRET</code></summary>

Client secret for the Linear OAuth app.

- **Define:** Set `LINEAR_CLIENT_SECRET` in the deployment environment
- **Required:** Yes
- **Environment override:** `LINEAR_CLIENT_SECRET`

</details>

<details class="plugin-config">
<summary><code>LINEAR_WEBHOOK_SECRET</code></summary>

Webhook signing secret used to verify Linear issue webhooks.

- **Define:** Set `LINEAR_WEBHOOK_SECRET` in the deployment environment
- **Required:** Yes for resource events; otherwise no
- **Environment override:** `LINEAR_WEBHOOK_SECRET`

</details>

## What users can do

- Look up Linear issues, teams, projects, and related workflow state.
- Create a new Linear issue from Slack thread context.
- Update issue fields such as state, assignee, title, or description.
- Add comments that preserve relevant code, Sentry, or reproduction links already present in the conversation.
- Create temporary watches or durable event tasks for new Linear issues when webhooks are enabled.

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

Junior verifies the `Linear-Signature` header on every delivery. Resource events stay disabled until `LINEAR_WEBHOOK_SECRET` is set.

Only workspace admins, or OAuth applications with the `admin` scope, can create or read Linear webhooks.

## Resource subscriptions

Set `LINEAR_WEBHOOK_SECRET` to enable resource subscriptions. See [Resource Subscriptions](/concepts/resource-subscriptions/) for the difference between temporary subscriptions and durable event tasks.

### `issue`

Subscribe to one issue with its Linear identifier, such as `SRE-123`.

<details class="resource-event">
<summary><code>issue.created</code></summary>

The issue was created.

</details>

### `team`

Subscribe to all new issues in a team with the Linear team key, such as `SRE`.

<details class="resource-event">
<summary><code>issue.created</code></summary>

An issue was created in the team.

</details>

Create the subscription or event task before the issue arrives. Junior does not replay earlier webhooks.

Identifiers are normalized to uppercase. Prefer team-scoped event tasks for monitor workflows that create many new issues.

Optional `match` values come from the resource type. For Linear issue and team events, `teamKey` is the uppercase team key such as `SRE`. Junior drops events that do not match before it wakes the agent. Prefer a team identifier for “all new issues in SRE”. Use `match.teamKey` when an issue-scoped watch or task needs an extra team guard.

## Verify

**OAuth:** Ask Junior to create or update a real Linear issue. If Linear is not connected, have a workspace admin complete the install. Confirm that Junior returns the issue key or URL in the same thread.

**Webhooks:** Create an event task for a team key, then create a test issue in that team. You can also create an issue-scoped task with `match.teamKey` set to the same team key and confirm non-matching teams do not fire.

## Security

- Junior stores the app tokens outside the model and sandbox.
- Webhooks use `LINEAR_WEBHOOK_SECRET`, not the OAuth app tokens.
- Issue titles, descriptions, and other webhook text are untrusted input.

## Failure modes

- **Linear is not connected:** Check `LINEAR_CLIENT_ID` and `LINEAR_CLIENT_SECRET`, then have a workspace admin install the app.
- **The connection expired:** Have a workspace admin install the app again.
- **Wrong team or project:** Name the team, project, or issue key in the Slack request.
- **Duplicate or vague tickets:** Give Junior the core problem, impact, and useful links from the thread.
- **Permission failure:** Confirm that the installed app can access the team, project, or issue.
- **Webhooks are ignored:** Check `LINEAR_WEBHOOK_SECRET`, confirm the webhook points at `/api/webhooks/linear`, and confirm a matching subscription or event task exists.
- **Event task stays unavailable:** Resource events stay disabled until `LINEAR_WEBHOOK_SECRET` is set and Junior is redeployed.

## Next step

Review [Resource Subscriptions](/concepts/resource-subscriptions/) and [Security Hardening](/operate/security-hardening/).
