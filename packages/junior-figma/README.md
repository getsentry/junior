# @sentry/junior-figma

Read-only Figma frame, layout, style, and comment lookups for Junior through the Figma REST API.

```bash
pnpm add @sentry/junior @sentry/junior-figma
```

```ts
import { defineJuniorPlugins } from "@sentry/junior";

export const plugins = defineJuniorPlugins(["@sentry/junior-figma"]);
```

Setup and configuration: https://junior.sentry.dev/extend/figma-plugin/
