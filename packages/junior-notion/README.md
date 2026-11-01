# @sentry/junior-notion

Notion page and data source search, fetch, and limited writes for Junior through Notion's hosted MCP server.

```bash
pnpm add @sentry/junior @sentry/junior-notion
```

```ts
import { defineJuniorPlugins } from "@sentry/junior";

export const plugins = defineJuniorPlugins(["@sentry/junior-notion"]);
```

Setup and configuration: https://junior.sentry.dev/extend/notion-plugin/
