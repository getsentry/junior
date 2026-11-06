# @sentry/junior-octolens

Social-listening analysis and monitoring for Junior through Octolens' hosted MCP server.

```bash
pnpm add @sentry/junior @sentry/junior-octolens
```

```ts
import { defineJuniorPlugins } from "@sentry/junior";

export const plugins = defineJuniorPlugins(["@sentry/junior-octolens"]);
```

Setup and configuration: https://junior.sentry.dev/extend/
