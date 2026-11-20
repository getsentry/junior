# @sentry/junior-linear

Linear issue workflows and issue events for Junior through Linear's hosted MCP server.

```bash
pnpm add @sentry/junior @sentry/junior-linear
```

```ts
import { defineJuniorPlugins } from "@sentry/junior";
import { linearPlugin } from "@sentry/junior-linear";

export const plugins = defineJuniorPlugins([linearPlugin()]);
```

Setup and configuration: https://junior.sentry.dev/extend/linear-plugin/
