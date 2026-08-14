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

Use the Linear plugin to find, create, update, comment on, and triage Linear issues from Slack. Each user connects their own Linear account through Linear's hosted MCP server.

Optional webhooks let Junior publish `issue.created` resource events for subscriptions and event tasks. User MCP OAuth and webhook ingress stay separate.

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
- Each user completes Linear's MCP OAuth flow the first time Junior calls a Linear MCP tool on their behalf.
- Junior sends the authorization link privately, then resumes the same thread automatically after the user authorizes.
- Webhooks use a separate Linear webhook secret. They do not use the user's MCP OAuth grant.

Junior uses Linear's hosted MCP tools for reads and writes. When an issue is created through that path, Junior links it to the current conversation.

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

## Verify

**OAuth:** Ask Junior to create or update a real Linear issue, complete the private authorization flow, and confirm the issue key or URL returns in the same thread.

**Webhooks:** Create an event task for a team key, then create a test issue in that team.

## Security

- Junior stores user MCP grants and does not include them in model input.
- Webhooks use the Linear webhook signing secret, not user MCP OAuth.
- Issue title, description, and other payload text are untrusted event content.

## Failure modes

- **No auth prompt or no resume:** Retry the Linear request and complete the private authorization flow when prompted.
- **Wrong team or project target:** Include the team name, project name, or existing Linear issue key explicitly in the Slack request.
- **Duplicate or low-signal tickets:** Give Junior the core problem, impact, and any supporting URLs from the thread so it can create a grounded issue instead of a vague summary.
- **Permission failures after connect:** The user's Linear account may not have access to that team, project, or issue. Retry with a resource the user can access.
- **Webhooks are ignored:** Check `LINEAR_WEBHOOK_SECRET`, confirm the webhook points at `/api/webhooks/linear`, and confirm a matching subscription or event task exists.
- **Event task stays unavailable:** Resource events stay disabled until `LINEAR_WEBHOOK_SECRET` is set and Junior is redeployed.

## Next step

Review [Resource Subscriptions](/concepts/resource-subscriptions/) and [Security Hardening](/operate/security-hardening/).
