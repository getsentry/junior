---
title: Linear Plugin
description: Configure the hosted Linear MCP server for issue search and ticket workflow operations.
type: tutorial
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

List the plugin in `juniorNitro({ pluginPackages: [...] })`:

```ts title="nitro.config.ts"
juniorNitro({
  pluginPackages: ["@sentry/junior-linear"],
});
```

## Auth model

- No `LINEAR_API_KEY`, shared workspace token, or custom OAuth app is required for the default setup.
- Each user completes Linear's MCP OAuth flow the first time Junior calls a Linear MCP tool on their behalf.
- Junior sends the authorization link privately, then resumes the same thread automatically after the user authorizes.
- The packaged plugin is optimized for interactive user-driven work in Slack rather than unattended background automation.

## Optional channel defaults

If a Slack channel usually files work into the same Linear team or project, store that as a conversation-scoped default:

```bash
jr-rpc config set linear.team Platform
jr-rpc config set linear.project "Cross-team reliability"
```

Use `linear.team` when a channel consistently maps to one owning team. Use `linear.project` only when a channel is genuinely centered on one project.

These defaults are optional fallbacks. If a user names a different team or project in a request, Junior should follow the explicit request instead of the stored default.

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
