# @sentry/junior-notion

`@sentry/junior-notion` adds read-only Notion search workflows for pages and data sources to Junior via a shared internal Notion integration.

Install it alongside `@sentry/junior`:

```bash
pnpm add @sentry/junior @sentry/junior-notion
```

Create an internal Notion integration by following Notion's Authorization guide:

- https://developers.notion.com/guides/get-started/authorization

In the Notion integration settings:

- choose the workspace where the integration will live
- enable the `Read content` capability
- copy the integration secret from the `Configuration` tab
- share any pages or data sources Junior should read via `•••` -> `Add connections`

Set that value in your host environment:

- `NOTION_TOKEN`

Then register the plugin package in `withJunior(...)`:

```js
import { withJunior } from "@sentry/junior/config";

export default withJunior({
  pluginPackages: ["@sentry/junior-notion"],
});
```

There is no `/notion auth` flow for this plugin. Once the token is configured and pages or data sources are shared with the integration, users can run `/notion <query>` directly.

## Search limitations

This plugin currently uses Notion's public `v1` API for search and content retrieval.

- `v1/search` is title-biased and does not match the richer `Best matches` behavior users see in notion.so.
- Results can differ from the UI even when the user can see a page in the Notion app.
- The most common cause of missing results is that the target page or data source is not directly shared with the integration.
- Newly shared content can also lag behind search indexing.

We also tested Notion's private `api/v3/search` endpoint with the same integration token. It accepted the token at the HTTP layer, but it did not return useful results for the same sample queries, so this plugin does not depend on `api/v3`.

For local debugging, the package exposes one Notion helper script through two subcommands that load the workspace env first:

```bash
pnpm notion:search -- --query "company holidays"
pnpm notion:fetch -- --id "<notion-id>" --object page
```

Full setup guide: https://junior.sentry.dev/extend/notion-plugin/
