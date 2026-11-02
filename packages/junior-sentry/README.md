# @sentry/junior-sentry

Sentry investigations, requested project, team, and alert changes, and signed issue and metric alert webhooks for Junior.

```bash
pnpm add @sentry/junior @sentry/junior-sentry
```

```ts
import { defineJuniorPlugins } from "@sentry/junior";
import { sentryPlugin } from "@sentry/junior-sentry";

export const plugins = defineJuniorPlugins([sentryPlugin()]);
```

Setup and configuration: https://junior.sentry.dev/extend/sentry-plugin/
