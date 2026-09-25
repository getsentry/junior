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
- Notion MCP requires user-based OAuth and does not support bearer token authentication, so this plugin is not suitable for fully headless automation.
- Existing OAuth connections may need reauthorization if Notion requires additional scopes for write tools.

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
