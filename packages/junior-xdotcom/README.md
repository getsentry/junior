# @sentry/junior-xdotcom

Read-only X post search, post lookup, and user timelines for Junior through the X API v2.

```bash
pnpm add @sentry/junior @sentry/junior-xdotcom
```

```ts
import { defineJuniorPlugins } from "@sentry/junior";

export const plugins = defineJuniorPlugins(["@sentry/junior-xdotcom"]);
```

Setup and configuration: https://junior.sentry.dev/extend/xdotcom-plugin/
