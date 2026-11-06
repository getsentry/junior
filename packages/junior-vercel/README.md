# @sentry/junior-vercel

Vercel deployment, alias, and log workflows and signed deployment webhooks for Junior.

```bash
pnpm add @sentry/junior @sentry/junior-vercel
```

```ts
import { defineJuniorPlugins } from "@sentry/junior";
import { vercelPlugin } from "@sentry/junior-vercel";

export const plugins = defineJuniorPlugins([vercelPlugin()]);
```

Setup and configuration: https://junior.sentry.dev/extend/vercel-plugin/
