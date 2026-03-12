---
title: Notion Plugin
description: Configure a shared internal Notion integration for read-only page and data source search workflows.
type: tutorial
summary: Set up the Notion plugin with an internal integration token and verify `/notion` page and data source search workflows.
prerequisites:
  - /extend/
related:
  - /concepts/credentials-and-oauth/
  - /operate/security-hardening/
---

The Notion plugin uses a shared internal integration so Slack users can search shared Notion pages and data sources through `/notion`.

Notion's public search API is more limited than the search experience in the Notion app. Junior uses the stable public API, so `/notion` works best when users search for the exact page or data source title they want to open.

## Setup

### Create an internal Notion integration

Start with Notion's [Authorization guide](https://developers.notion.com/guides/get-started/authorization), then create an internal integration in the Notion integrations dashboard. Notion's docs describe internal integrations as single-workspace integrations that authenticate with one integration token rather than OAuth.

After you create the integration:

1. Open the `Configuration` tab.
2. Copy the integration secret.
3. Set it in your host environment as `NOTION_TOKEN`.

### Enable the required Notion capability

Open the integration's `Capabilities` tab and enable `Read content`.

Junior's Notion workflow searches pages and data sources, retrieves page markdown, and queries data source rows, so `Read content` is the required content capability. Notion documents capability requirements here:

- [Integration capabilities](https://developers.notion.com/reference/capabilities)
- [Retrieve a page as markdown](https://developers.notion.com/reference/retrieve-page-markdown)
- [Query a data source](https://developers.notion.com/reference/query-a-data-source)

### Register the plugin in Junior

Install and register the plugin package:

```ts title="next.config.mjs"
import { withJunior } from "@sentry/junior/config";

export default withJunior({
  pluginPackages: ["@sentry/junior-notion"],
});
```

Set the integration token in your host environment:

- `NOTION_TOKEN`

### Share pages and data sources with the integration

Notion internal integrations only see the pages and data sources that are explicitly shared with them. Notion's docs describe this as a manual sharing step:

1. Open the page or data source in Notion.
2. Click the `•••` menu in the upper right.
3. Choose `Add connections`.
4. Select your integration.

This is the most common reason `/notion` returns no matches or a `404`/permission-style error from the Notion API.

### Runtime usage flow

1. Admin configures `NOTION_TOKEN` once.
2. Admin shares the relevant pages or data sources with the integration in Notion.
3. Users run `/notion <query>` in Slack.

## Verify

- `NOTION_TOKEN` is set in the host environment.
- The target page or data source is shared with the integration in Notion.
- A real `/notion <query>` request returns a summary and source URL.

For local debugging, you can also run:

```bash
pnpm notion:search -- --query "company holidays"
pnpm notion:fetch -- --id "<notion-id>" --object page
```

## Failure modes

- No search matches: the page or data source may not be shared with the integration yet, or Notion search may still be indexing immediately after content was shared.
- `403` from Notion: the integration is missing `Read content`.
- `401` from Notion: `NOTION_TOKEN` is missing or invalid.
- Retrieval errors: the top matching page or data source could not be fetched for summarization.
- Search results differ from notion.so: Junior uses Notion's public `v1` API, which is title-biased and does not expose the richer `Best matches` behavior from the Notion UI.

Notion's search docs note that directly shared pages are guaranteed to appear, while newly shared content can still be delayed by search indexing. If a page or data source was just shared and `/notion` still misses it, retry once indexing catches up.

## Next step

Review [Credentials & OAuth](/concepts/credentials-and-oauth/) and [Security Hardening](/operate/security-hardening/).
