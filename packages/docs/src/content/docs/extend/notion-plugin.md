---
title: Notion Plugin
description: Configure the hosted Notion MCP server for read-only page and data source search workflows.
type: tutorial
prerequisites:
  - /extend/
related:
  - /concepts/credentials-and-oauth/
  - /operate/security-hardening/
---

The Notion plugin uses Notion's hosted MCP server so Slack users can search and fetch content from their own Notion account context.

Junior intentionally keeps this plugin read-only. It exposes only Notion's `notion-search` and `notion-fetch` MCP tools, even though the hosted server supports write-capable tools.

Notion search is still title-biased. Requests work best when users search for the exact page or data source title they want to open.

## Install

Install the plugin package alongside `@sentry/junior`:

```bash
pnpm add @sentry/junior @sentry/junior-notion
```

## Runtime setup

List the plugin in `createApp({ pluginPackages: [...] })`:

```ts title="api/index.ts"
const app = await createApp({
  pluginPackages: ["@sentry/junior-notion"],
});

export default handle(app);
```

## Auth model

- No `NOTION_TOKEN` or shared integration secret is required.
- Each user completes OAuth the first time Junior calls a Notion MCP tool on their behalf.
- Junior sends the authorization link privately, then resumes the same thread automatically after the user authorizes.
- Notion MCP requires user-based OAuth and does not support bearer token authentication, so this plugin is not suitable for fully headless automation.

## What users can do

- Search for a page or data source by title-style query.
- Fetch the best matching result and summarize its content.
- Disconnect their account later from Junior App Home with `Unlink`.

## Verify

Confirm a real user can connect and search successfully:

1. Ask Junior to search Notion for a real page or data source title.
2. Complete the private OAuth flow when Junior prompts for it.
3. Confirm the thread resumes automatically and includes the expected Notion result.
4. Open Junior App Home and confirm Notion appears under `Connected accounts`.

## Failure modes

- No auth prompt or no resume: the user still needs to complete the OAuth flow. Retry the request and finish the private authorization flow when prompted.
- No search matches: the query is too broad, the content is outside the user's Notion permissions, or search has not indexed recent changes yet.
- Search results differ from notion.so: MCP search is still title-biased. Search by the exact title when possible.
- Connected-source results are missing: search across Slack, Google Drive, or Jira requires a Notion AI plan. Without it, search is limited to the user's Notion workspace.
- Retrieval errors after a match: the matching page or data source could not be fetched for summarization. Confirm the user can still access that object in Notion.

## Next step

Review [Credentials & OAuth](/concepts/credentials-and-oauth/) and [Security Hardening](/operate/security-hardening/).
