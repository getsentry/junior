# @sentry/junior-amplitude

Read-only Amplitude product analytics for Junior through Amplitude's hosted MCP server.

```bash
pnpm add @sentry/junior @sentry/junior-amplitude
```

```ts
import { defineJuniorPlugins } from "@sentry/junior";

export const plugins = defineJuniorPlugins(["@sentry/junior-amplitude"]);
```

Setup and configuration: https://junior.sentry.dev/extend/amplitude-plugin/
