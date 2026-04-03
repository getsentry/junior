# @sentry/junior-notion

`@sentry/junior-notion` adds read-only Notion search workflows for pages and data sources to Junior through Notion's hosted MCP server.

Install it alongside `@sentry/junior`:

```bash
pnpm add @sentry/junior @sentry/junior-notion
```

Then register the plugin package in `juniorNitro(...)`:

```ts title="nitro.config.ts"
juniorNitro({
  pluginPackages: ["@sentry/junior-notion"],
});
```

This package does not use `NOTION_TOKEN` or a shared workspace integration. Each user connects their own Notion account the first time Junior calls a Notion MCP tool. Junior sends the OAuth link privately and resumes the thread automatically after the user authorizes.

Junior intentionally keeps this package read-only by exposing only Notion's `notion-search` and `notion-fetch` MCP tools. The plugin does not expose create, update, move, or other write-capable Notion tools.

## Search limitations

This package uses Notion MCP search and fetch rather than the older REST helper flow.

- Search is still title-biased, so prompts work best when users search for the actual page or data source title.
- Results can differ from the Notion UI even when the user can see a page in the app.
- Search across connected sources like Slack, Google Drive, and Jira requires a Notion AI plan. Without Notion AI, search is limited to the user's Notion workspace.
- Missing results are usually a permissions problem on the user's Notion account or a weak query phrase.

## Auth model

- Notion MCP requires user-based OAuth and does not support bearer token authentication.
- This package is not suitable for fully headless or unattended automation.
- Users can disconnect from Junior App Home with `Unlink`, or by asking Junior to disconnect Notion.

Full setup guide: https://junior.sentry.dev/extend/notion-plugin/
