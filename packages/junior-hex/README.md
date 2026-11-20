# @sentry/junior-hex

Hex data warehouse queries for Junior through Hex's hosted MCP server.

```bash
pnpm add @sentry/junior @sentry/junior-hex
```

```ts
import { defineJuniorPlugins } from "@sentry/junior";

export const plugins = defineJuniorPlugins(["@sentry/junior-hex"]);
```

Setup and configuration: https://junior.sentry.dev/extend/hex-plugin/
