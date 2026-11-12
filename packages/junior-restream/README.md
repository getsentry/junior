# @sentry/junior-restream

Restream events, chat, analytics, recordings, and transcripts for Junior through Restream's hosted MCP server.

```bash
pnpm add @sentry/junior @sentry/junior-restream
```

```ts
import { defineJuniorPlugins } from "@sentry/junior";

export const plugins = defineJuniorPlugins(["@sentry/junior-restream"]);
```

Setup and configuration: https://junior.sentry.dev/extend/restream-plugin/
