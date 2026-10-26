---
title: Notion Plugin
description: Configure the hosted Notion MCP server for page search, fetch, and limited write workflows.
type: tutorial
prerequisites:
  - /extend/
related:
  - /concepts/credentials-and-oauth/
  - /operate/security-hardening/
---

The Notion plugin uses Notion's hosted MCP server so Slack users can search, fetch, create, update, and move content from their own Notion account context.

Junior exposes a deliberately limited Notion tool surface:

- `notion-search`
- `notion-fetch`
- `notion-create-pages`
- `notion-update-page`
- `notion-move-pages`

Broader administrative or destructive operations stay out of scope.

Notion search is still title-biased. Requests work best when users search for the exact page or data source title they want to open.

## Install

Install the plugin package alongside `@sentry/junior`:

```bash
pnpm add @sentry/junior @sentry/junior-notion
```

## Runtime setup

Add the package name to the plugin set exported from `plugins.ts`:

```ts title="plugins.ts"
import { defineJuniorPlugins } from "@sentry/junior";

export const plugins = defineJuniorPlugins(["@sentry/junior-notion"]);
```

## Config

No plugin config is required.

## Auth model

- No `NOTION_TOKEN` or shared integration secret is required.
- Each user completes OAuth the first time Junior calls a Notion MCP tool on their behalf.
- Junior sends the authorization link privately, then resumes the same thread automatically after the user authorizes.
- Notion MCP requires user-based OAuth and does not support bearer token authentication. Without a service account, this plugin is not suitable for fully headless automation.
- Existing OAuth connections may need reauthorization if Notion requires additional scopes for write tools.

## Optional service account

A Junior admin can connect one Notion account that Junior itself uses, for
example `junior@example.com`. Then people who have not connected Notion can
search and fetch pages without OAuth. Scheduled automations can read Notion
too.

1. Create the Notion account and add it to your workspace. Give it only the
   pages and teamspaces that everyone who can talk to Junior may read.
2. In the Junior dashboard, open **Admin**. Under **Service accounts**, click
   **Connect** on Notion. Only Junior admins see this section.
3. Sign in to Notion as that account, not as yourself.
4. Return to the Admin page. Notion shows as connected, with the admin who
   connected it.

If the dashboard is not available, run `junior service-account connect notion`
on a machine with a browser and the deployment `REDIS_URL`.

The service account calls only `notion-search` and `notion-fetch`. To create,
update, or move pages, Junior still asks the person to connect their own
Notion account. After they connect, Junior uses their account for all Notion
tools.

To remove the account, click **Disconnect** on the Admin page, or run
`junior service-account disconnect notion`. Then
remove Junior's connection in the Notion account settings to revoke the grant.
If Notion revokes the grant, Junior removes the account and falls back to
per-user OAuth.

### Use only the service account

To stop people from connecting their own Notion accounts, turn off user
OAuth for the service account in your plugin list. Then everyone uses the shared
account, and Junior never sends a Notion connect link. The shared account
must cover every Notion tool that Junior loads, so also limit the tools:

```ts title="plugins.ts"
export const plugins = defineJuniorPlugins(["@sentry/junior-notion"], {
  manifests: {
    notion: {
      mcp: { allowedTools: ["notion-search", "notion-fetch"] },
      serviceAccount: {
        userOAuth: false,
        mcpTools: ["notion-search", "notion-fetch"],
      },
    },
  },
});
```

Until an admin connects the account, Junior tells people that Notion is not
available yet. If Notion revokes the grant, Notion stays unavailable until an
admin connects the account again.

## What users can do

- Search for a page or data source by title-style query.
- Fetch the best matching result and summarize its content.
- Create a new page when the user explicitly asks.
- Update page content or properties when the user explicitly asks.
- Move a page to a new parent when the user explicitly asks.
- Disconnect their account later from Junior App Home with `Unlink`.

## Safety boundaries

- Junior defaults to read-only lookup unless the user explicitly asks to create, edit, or move Notion content.
- Write tools go through Junior's normal MCP action review path.
- Database deletion, schema redesign, and other broad administrative operations stay out of scope.
- Permission failures remain user-scoped. Junior can only act on Notion content the authenticated user can access.
- With a service account, anyone who can talk to Junior can read what that account can read.

## Verify

Confirm a real user can connect and complete both read and write workflows:

1. Ask Junior to search Notion for a real page or data source title.
2. Complete the private OAuth flow when Junior prompts for it.
3. Confirm the thread resumes automatically and includes the expected Notion result.
4. Ask Junior to create or update a real page the user can access.
5. Confirm Junior returns the resulting Notion page URL.
6. Open Junior App Home and confirm Notion appears under `Connected accounts`.

## Failure modes

- No auth prompt or no resume: the user still needs to complete the OAuth flow. Retry the request and finish the private authorization flow when prompted.
- Reauthorization required for writes: disconnect Notion from Junior App Home, retry the write request, and complete the private OAuth flow again if Notion asks for additional scopes.
- No search matches: the query is too broad, the content is outside the user's Notion permissions, or search has not indexed recent changes yet.
- Search results differ from notion.so: MCP search is still title-biased. Search by the exact title when possible.
- Connected-source results are missing: search across Slack, Google Drive, or Jira requires a Notion AI plan. Without it, search is limited to the user's Notion workspace.
- Retrieval errors after a match: the matching page or data source could not be fetched for summarization. Confirm the user can still access that object in Notion.
- Write denied: the authenticated user may lack edit access to the target page or parent. Retry with a destination the user can edit.

## Next step

Review [Credentials & OAuth](/concepts/credentials-and-oauth/) and [Security Hardening](/operate/security-hardening/).
