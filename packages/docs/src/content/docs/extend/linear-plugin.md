---
title: Linear Plugin
description: Configure the hosted Linear MCP server for issue search and ticket workflow operations.
type: tutorial
summary: Connect Linear and create conversation-linked issues without replacing Linear's hosted OAuth flow.
prerequisites:
  - /extend/
related:
  - /concepts/credentials-and-oauth/
  - /operate/security-hardening/
---

The Linear plugin uses Linear's hosted MCP server so Slack users can find, create, update, comment on, and triage Linear issues from their own Linear account context.

Junior keeps the setup lightweight: the packaged plugin points at Linear's hosted remote MCP endpoint and lets Linear handle the user OAuth flow the first time a Linear tool is needed.

## Install

Install the plugin package alongside `@sentry/junior`:

```bash
pnpm add @sentry/junior @sentry/junior-linear
```

## Runtime setup

Add the plugin to the set exported from `plugins.ts`:

```ts title="plugins.ts"
import { defineJuniorPlugins } from "@sentry/junior";
import { linearPlugin } from "@sentry/junior-linear";

export const plugins = defineJuniorPlugins([linearPlugin()]);
```

## Auth model

- No `LINEAR_API_KEY`, shared workspace token, or custom OAuth app is required for the default setup.
- Each user completes Linear's MCP OAuth flow the first time Junior calls a Linear MCP tool on their behalf.
- Junior sends the authorization link privately, then resumes the same thread automatically after the user authorizes.
- The packaged plugin is optimized for interactive user-driven work in Slack rather than unattended background automation.

Junior uses Linear's hosted MCP tools for reads and writes. When an issue is created through that path, Junior links it to the current conversation.

## Config

Set conversation config with `jr-rpc config set`, or define the same keys for every conversation with `createApp({ configDefaults })`. An explicit team or project in a request always wins.

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

## What users can do

- Look up Linear issues, teams, projects, and related workflow state.
- Create a new Linear issue from Slack thread context.
- Update issue fields such as state, assignee, title, or description.
- Add comments that preserve relevant code, Sentry, or reproduction links already present in the conversation.

## Verify

Confirm a real user can connect and complete a Linear workflow successfully:

1. Ask Junior to create or update a real Linear issue.
2. Complete the private OAuth flow when Junior prompts for it.
3. Confirm the thread resumes automatically and returns the Linear issue key or URL.
4. Open the issue in Linear and confirm the created or updated content matches the Slack request.
5. Open Junior App Home and confirm Linear appears under `Connected accounts`.

## Failure modes

- No auth prompt or no resume: retry the Linear request and complete the private authorization flow when prompted.
- Wrong team or project target: include the team name, project name, or existing Linear issue key explicitly in the Slack request.
- Duplicate or low-signal tickets: give Junior the core problem, impact, and any supporting URLs from the thread so it can create a grounded issue instead of a vague summary.
- Permission failures after connect: the user's Linear account may not have access to that team, project, or issue. Retry with a resource the user can access.

## Next step

Review [Credentials & OAuth](/concepts/credentials-and-oauth/) and [Security Hardening](/operate/security-hardening/).
