---
title: Notion Plugin
description: Configure a shared internal Notion integration for read-only page and data source search workflows.
type: tutorial
summary: Install the Notion plugin, register it with withJunior, configure a shared integration token, and verify `/notion` search workflows.
prerequisites:
  - /extend/
related:
  - /concepts/credentials-and-oauth/
  - /operate/security-hardening/
---

The Notion plugin uses a shared internal integration so Slack users can search shared Notion pages and data sources through `/notion`.

Notion's public search API is more limited than the search experience in the Notion app. Junior uses the stable public API, so `/notion` works best when users search for the exact page or data source title they want to open.

## Install

Install the plugin package alongside `@sentry/junior`:

```bash
pnpm add @sentry/junior @sentry/junior-notion
```

## Register with `withJunior`

Add the package to `pluginPackages` so runtime discovery includes the Notion plugin:

```ts title="next.config.mjs"
import { withJunior } from "@sentry/junior/config";

export default withJunior({
  pluginPackages: ["@sentry/junior-notion"],
});
```

## Configure environment variables

Set these values in the host environment:

| Variable       | Required | Purpose                                                              |
| -------------- | -------- | -------------------------------------------------------------------- |
| `NOTION_TOKEN` | Yes      | Internal integration secret used for search and page fetch requests. |

## Create the Notion integration

Start with Notion's [Authorization guide](https://developers.notion.com/guides/get-started/authorization), then create an internal integration in the Notion integrations dashboard.

After you create the integration:

1. Choose the workspace where the integration will live.
2. Open the `Capabilities` tab and enable `Read content`.
3. Open the `Configuration` tab and copy the integration secret.
4. Store that secret in your deployment environment as `NOTION_TOKEN`.

## Share pages and data sources with the integration

Notion internal integrations only see the pages and data sources that are explicitly shared with them:

1. Open the page or data source in Notion.
2. Click the `•••` menu in the upper right.
3. Choose `Add connections`.
4. Select your integration.

This is the most common reason `/notion` returns no matches or a permission-style error.

## Verify

Confirm the token is set, the target content is shared with the integration, and a real search succeeds:

- Run `/notion <query>` in Slack and confirm the response includes the expected page or data source.
- If needed, verify the same content through the local helper scripts:

```bash
pnpm notion:search -- --query "company holidays"
pnpm notion:fetch -- --id "<notion-id>" --object page
```

## Failure modes

- No search matches: the target page or data source is not shared with the integration yet, or Notion search is still indexing newly shared content. Share the content directly and retry after indexing catches up.
- `403` from Notion: the integration is missing `Read content`. Enable that capability in the integration settings.
- `401` from Notion: `NOTION_TOKEN` is missing or invalid. Update the deployment secret and redeploy.
- Retrieval errors after a match: the matching page or data source could not be fetched for summarization. Confirm the object is still shared and accessible to the integration.
- Search results differ from notion.so: Junior uses Notion's public `v1` API, which is title-biased and does not expose the richer `Best matches` behavior from the Notion UI. Search by the exact title when possible.

## Next step

Review [Credentials & OAuth](/concepts/credentials-and-oauth/) and [Security Hardening](/operate/security-hardening/).
